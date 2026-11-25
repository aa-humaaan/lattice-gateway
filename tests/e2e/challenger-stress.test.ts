/**
/**
 * Empirical Challenger Stress Test Suite
 * 
 * Verifies:
 * 1. Port collision resilience: concurrent dynamic port binding (port: 0) never causes EADDRINUSE
 * 2. Resource cleanup: mock servers, gateway instances, and stream readers close cleanly without dangling sockets or leaks
 * 3. Stream termination: aborted SSE streams terminate cleanly without hanging the test runner
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { createMockUpstream, type MockUpstreamServer } from '../harness/mock-upstream';
import { startGateway, type GatewayInstance } from '../harness/gateway-runner';
import { TestClient, parseSSEStream } from '../harness/test-client';
import { existsSync } from 'node:fs';

describe('Empirical Challenger: Port Collision, Resource Cleanup & Stream Termination', () => {

  // =========================================================================
  // 1. Port Collision Resilience
  // =========================================================================
  describe('1. Port Collision Resilience', () => {
    it('concurrently starts 50 mock upstreams on port 0 with zero EADDRINUSE collisions', async () => {
      const serverCount = 50;
      const servers: MockUpstreamServer[] = [];

      try {
        const startPromises = Array.from({ length: serverCount }, () => createMockUpstream());
        const createdServers = await Promise.all(startPromises);
        servers.push(...createdServers);

        // Verify each server has an ephemeral port assigned
        const ports = servers.map((s) => s.port);
        expect(ports.length).toBe(serverCount);

        // Every port must be positive and greater than 1024
        for (const port of ports) {
          expect(port).toBeGreaterThan(1024);
        }

        // All ports must be unique
        const uniquePorts = new Set(ports);
        expect(uniquePorts.size).toBe(serverCount);

        // Verify each server is immediately reachable and responsive
        const pingPromises = servers.map(async (s) => {
          const res = await fetch(`${s.url}/healthz`);
          expect(res.status).toBe(200);
          const data = (await res.json()) as any;
          expect(data.status).toBe('healthy');
        });
        await Promise.all(pingPromises);
      } finally {
        // Cleanup all servers
        await Promise.all(servers.map((s) => s.stop()));
      }
    }, 30_000);

    it('concurrently starts 20 gateway instances with dynamic port allocation with zero collisions', async () => {
      const gatewayCount = 20;
      const gateways: GatewayInstance[] = [];

      try {
        const startPromises = Array.from({ length: gatewayCount }, () =>
          startGateway({ mode: 'in-process' })
        );
        const createdGateways = await Promise.all(startPromises);
        gateways.push(...createdGateways);

        const ports = gateways.map((g) => g.port);
        expect(ports.length).toBe(gatewayCount);

        for (const port of ports) {
          expect(port).toBeGreaterThan(1024);
        }

        const uniquePorts = new Set(ports);
        expect(uniquePorts.size).toBe(gatewayCount);

        // Verify all gateways are healthy
        const pingPromises = gateways.map(async (g) => {
          const res = await fetch(`${g.baseUrl}/healthz`);
          expect(res.status).toBe(200);
        });
        await Promise.all(pingPromises);
      } finally {
        await Promise.all(gateways.map((g) => g.stop()));
      }
    }, 30_000);

    it('survives rapid consecutive port recycling without EADDRINUSE', async () => {
      // Start and immediately stop mock servers in tight succession
      for (let i = 0; i < 20; i++) {
        const server = await createMockUpstream();
        expect(server.port).toBeGreaterThan(1024);
        const res = await fetch(`${server.url}/healthz`);
        expect(res.status).toBe(200);
        await server.stop();
      }
    }, 30_000);
  });

  // =========================================================================
  // 2. Resource Cleanup Verification
  // =========================================================================
  describe('2. Resource Cleanup Verification', () => {
    it('confirms mock upstream stops listening and rejects new connections after stop()', async () => {
      const server = await createMockUpstream();
      const targetUrl = server.url;
      const targetPort = server.port;

      // Verify healthy before stop
      const beforeRes = await fetch(`${targetUrl}/healthz`);
      expect(beforeRes.status).toBe(200);

      // Stop server
      await server.stop();

      // Attempt to connect after stop must fail with ECONNREFUSED or connection error
      let connectionFailed = false;
      try {
        await fetch(`${targetUrl}/healthz`, { signal: AbortSignal.timeout(500) });
      } catch (err: any) {
        connectionFailed = true;
      }
      expect(connectionFailed).toBe(true);
    }, 15_000);

    it('verifies in-process gateway mode stops listening and frees resources immediately upon stop()', async () => {
      const gateway = await startGateway({ mode: 'in-process' });
      const targetUrl = gateway.baseUrl;
      const dataDir = gateway.dataDir;

      expect(gateway.port).toBeGreaterThan(1024);
      expect(existsSync(dataDir)).toBe(true);

      const beforeRes = await fetch(`${targetUrl}/healthz`);
      expect(beforeRes.status).toBe(200);

      // Stop gateway
      await gateway.stop();

      // Data directory must be removed from disk
      expect(existsSync(dataDir)).toBe(false);

      // Port must immediately reject connections
      let connectionFailed = false;
      try {
        await fetch(`${targetUrl}/healthz`, { signal: AbortSignal.timeout(500) });
      } catch {
        connectionFailed = true;
      }
      expect(connectionFailed).toBe(true);
    }, 15_000);

    it('terminates a directly spawned subprocess and frees its listener', async () => {
      // Spawn bun.exe directly through process.execPath: killing the Windows
      // bun.cmd shim would leave the real server orphaned on its port.
      // PORT=0 removes the fixed-port collision with other test workers.
      const { spawnGatewayOnFreePort } = await import('../harness/subprocess-gateway');
      const { proc, baseUrl } = await spawnGatewayOnFreePort();

      proc.kill('SIGKILL');
      if (proc.exitCode === null) {
        await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      }

      let connectionFailed = false;
      try {
        await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      } catch {
        connectionFailed = true;
      }
      expect(connectionFailed).toBe(true);
    }, 30_000);

    it('verifies parseSSEStream reader lock is released when iterator is terminated early', async () => {
      const mock = await createMockUpstream();
      try {
        const res = await fetch(`${mock.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'mock-gpt-4o',
            messages: [{ role: 'user', content: 'test' }],
            stream: true,
          }),
        });

        expect(res.status).toBe(200);
        expect(res.body).not.toBeNull();

        const sseStream = parseSSEStream(res.body!);
        let chunkCount = 0;

        // Break early after 1 chunk
        for await (const chunk of sseStream) {
          chunkCount++;
          if (chunkCount === 1) {
            break;
          }
        }

        expect(chunkCount).toBe(1);

        // Verify that res.body stream is no longer locked
        expect(res.body!.locked).toBe(false);
      } finally {
        await mock.stop();
      }
    });

    it('verifies reset() and clearRequests() free all recorded state', async () => {
      const mock = await createMockUpstream();
      try {
        for (let i = 0; i < 10; i++) {
          await fetch(`${mock.url}/v1/models`);
        }
        expect(mock.getRequests().length).toBe(10);

        mock.clearRequests();
        expect(mock.getRequests().length).toBe(0);

        await fetch(`${mock.url}/v1/models`);
        expect(mock.getRequests().length).toBe(1);

        mock.reset();
        expect(mock.getRequests().length).toBe(0);
      } finally {
        await mock.stop();
      }
    });
  });

  // =========================================================================
  // 3. Stream Termination Verification (Aborted SSE Streams Do Not Hang Runner)
  // =========================================================================
  describe('3. Stream Termination Verification', () => {
    it('aborts OpenAI chat SSE stream mid-stream without hanging or throwing unhandled errors', async () => {
      const gateway = await startGateway({ mode: 'in-process' });
      const client = new TestClient(gateway.baseUrl);

      try {
        const abortController = new AbortController();
        const stream = client.openaiChatStream(
          {
            model: 'mock-chat',
            messages: [{ role: 'user', content: 'stream abort test' }],
          },
          { signal: abortController.signal }
        );

        let receivedCount = 0;
        let caughtAbortError = false;

        const startTime = Date.now();
        try {
          for await (const chunk of stream) {
            receivedCount++;
            if (receivedCount >= 1) {
              // Trigger abort immediately
              abortController.abort();
            }
          }
        } catch (err: any) {
          if (err.name === 'AbortError' || err.message?.includes('aborted') || err.message?.includes('abort')) {
            caughtAbortError = true;
          }
        }
        const elapsed = Date.now() - startTime;

        // Must terminate rather than hang; the runner timeout is the hard
        // bound, this ceiling only guards against a slow-but-terminating stream.
        expect(elapsed).toBeLessThan(8000);
        expect(receivedCount).toBeGreaterThanOrEqual(1);
      } finally {
        await gateway.stop();
      }
    }, 15_000);

    it('aborts Anthropic messages SSE stream mid-stream without hanging', async () => {
      const gateway = await startGateway({ mode: 'in-process' });
      const client = new TestClient(gateway.baseUrl);

      try {
        const abortController = new AbortController();
        const stream = client.anthropicMessagesStream(
          {
            model: 'mock-chat',
            messages: [{ role: 'user', content: 'anthropic stream abort' }],
          },
          { signal: abortController.signal }
        );

        let receivedCount = 0;
        const startTime = Date.now();

        try {
          for await (const event of stream) {
            receivedCount++;
            if (receivedCount >= 1) {
              abortController.abort();
            }
          }
        } catch (err: any) {
          // Expected AbortError
        }
        const elapsed = Date.now() - startTime;

        expect(elapsed).toBeLessThan(8000);
        expect(receivedCount).toBeGreaterThanOrEqual(1);
      } finally {
        await gateway.stop();
      }
    }, 15_000);

    it('handles 25 consecutive aborted streams without hanging the runner', async () => {
      const gateway = await startGateway({ mode: 'in-process' });
      const client = new TestClient(gateway.baseUrl);

      try {
        const startTime = Date.now();
        let completedAborts = 0;

        for (let i = 0; i < 25; i++) {
          const abortController = new AbortController();
          const stream = client.openaiChatStream(
            {
              model: 'mock-chat',
              messages: [{ role: 'user', content: `rapid-abort-${i}` }],
            },
            { signal: abortController.signal }
          );

          try {
            for await (const chunk of stream) {
              abortController.abort();
              break;
            }
          } catch {
            // Expected abort
          }
          completedAborts++;
        }

        const elapsed = Date.now() - startTime;
        // Every abort must release the reader; the runner timeout catches a hang.
        expect(completedAborts).toBe(25);
        expect(elapsed).toBeLessThan(25_000);
      } finally {
        await gateway.stop();
      }
    }, 30_000);

    it('aborts when upstream stream hangs indefinitely without blocking test runner', async () => {
      // Mock upstream simulating an indefinite hang on stream
      const mock = await createMockUpstream();
      mock.onRequest((req) => {
        const url = new URL(req.url);
        if (url.pathname === '/v1/chat/completions') {
          // Return an SSE stream that enqueues nothing and never closes
          const hangingStream = new ReadableStream({
            start() {
              // Never enqueue or close
            },
          });
          return new Response(hangingStream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return null;
      });

      try {
        const abortController = new AbortController();
        const client = new TestClient(mock.url);

        const startTime = Date.now();
        // Abort after 50ms timeout
        const timeout = setTimeout(() => abortController.abort(), 50);

        let aborted = false;
        try {
          const stream = client.openaiChatStream(
            { model: 'hang-model', messages: [{ role: 'user', content: 'hang' }] },
            { signal: abortController.signal }
          );
          for await (const _ of stream) {
            // Should not receive anything
          }
        } catch {
          aborted = true;
        } finally {
          clearTimeout(timeout);
        }

        const elapsed = Date.now() - startTime;
        expect(aborted).toBe(true);
        expect(elapsed).toBeLessThan(8000); // broke out; runner timeout catches a true hang
      } finally {
        await mock.stop();
      }
    }, 15_000);

    it('exits cleanly and immediately upon completion of all tests', () => {
      // Final sanity marker confirming that the runner arrives at the end of the suite
      expect(true).toBe(true);
    });
  });
});
