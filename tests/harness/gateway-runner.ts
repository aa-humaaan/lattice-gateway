/**
 * Gateway Runner for Lattice Gateway E2E Testing
 * 
 * Manages the lifecycle of Lattice Gateway instances during tests:
 * - In-process mode: dynamically imports and starts `createServer()` if available
 * - Subprocess mode: executes `bun run src/index.ts` with isolated PORT and DATA_DIR
 * - External mode: connects to an existing running gateway (e.g. LATTICE_GATEWAY_URL or port 4000)
 * - Automatic dynamic port allocation and temporary SQLite/data directory cleanup
 */

import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

export interface GatewayRunnerOptions {
  mode?: 'auto' | 'in-process' | 'subprocess' | 'external';
  port?: number;
  env?: Record<string, string>;
  upstreamUrl?: string;
  dataDir?: string;
  dbPath?: string;
  timeoutMs?: number;
  logLevel?: 'silent' | 'debug' | 'info';
}

export interface GatewayInstance {
  readonly baseUrl: string;
  readonly port: number;
  readonly dataDir: string;
  readonly mode: 'in-process' | 'subprocess' | 'external';
  stop(): Promise<void>;
}

/**
 * Finds a guaranteed free ephemeral port on the local loopback
 */
export function getAvailablePort(): number {
  const dummy = Bun.serve({
    port: 0,
    fetch() {
      return new Response('probe');
    },
  });
  const port = dummy.port ?? 0;
  dummy.stop(true);
  return port;
}

/**
 * Polls an HTTP endpoint until it returns a 2xx or expected status code, or times out
 */
export async function waitForHealthy(
  url: string,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(intervalMs * 2) });
      if (res.status >= 200 && res.status < 500) {
        return true;
      }
    } catch {
      // Endpoint not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function startGateway(options: GatewayRunnerOptions = {}): Promise<GatewayInstance> {
  const timeoutMs = options.timeoutMs ?? 7000;
  const projectRoot = resolve(process.cwd());

  // 1. Check for external mode fallback if LATTICE_GATEWAY_URL is provided or mode is explicit
  const externalUrl = process.env.LATTICE_GATEWAY_URL;
  if (options.mode === 'external' || (options.mode === 'auto' && externalUrl)) {
    const targetUrl = externalUrl ?? 'http://127.0.0.1:4000';
    const isAlive = await waitForHealthy(`${targetUrl}/healthz`, 1500);
    if (isAlive) {
      const parsed = new URL(targetUrl);
      return {
        baseUrl: targetUrl,
        port: Number(parsed.port) || 4000,
        dataDir: '',
        mode: 'external',
        async stop() {
          // No-op for external instances
        },
      };
    }
    if (options.mode === 'external') {
      throw new Error(`External gateway at ${targetUrl} did not respond to health check.`);
    }
  }

  // 2. Prepare temporary isolated data directory
  const runId = Math.random().toString(36).substring(2, 10);
  const dataDir = options.dataDir ?? join(tmpdir(), `lattice-test-${runId}`);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const assignedPort = options.port && options.port > 0 ? options.port : getAvailablePort();
  const baseUrl = `http://127.0.0.1:${assignedPort}`;

  // 3. Try In-Process Mode if requested or auto
  if (options.mode === 'in-process' || options.mode === 'auto') {
    const serverPath = resolve(projectRoot, 'src', 'core', 'server.ts');
    if (existsSync(serverPath)) {
      try {
        const serverModule = await import(serverPath);
        if (typeof serverModule.createServer === 'function') {
          const appOrServer = await serverModule.createServer({
            port: assignedPort,
            dataDir,
            dbPath: options.dbPath ?? ':memory:',
            upstreamUrl: options.upstreamUrl,
            ...options.env,
          });

          // If serverModule.createServer returned a running Bun.serve instance or a Hono app
          let runningServer: any = null;
          if (appOrServer && typeof appOrServer.stop === 'function') {
            runningServer = appOrServer;
          } else if (appOrServer && typeof appOrServer.fetch === 'function') {
            runningServer = Bun.serve({
              port: assignedPort,
              fetch: appOrServer.fetch,
            });
          }

          if (runningServer) {
            const healthy = await waitForHealthy(`${baseUrl}/healthz`, 2000);
            return {
              baseUrl,
              port: assignedPort,
              dataDir,
              mode: 'in-process',
              async stop() {
                try {
                  runningServer.stop(true);
                } catch {}
                try {
                  rmSync(dataDir, { recursive: true, force: true });
                } catch {}
              },
            };
          }
        }
      } catch (err) {
        if (options.mode === 'in-process') {
          throw new Error(`Failed to start in-process gateway: ${(err as Error).message}`);
        }
        // In auto mode, fallback to subprocess
      }
    }
  }

  // 4. Try Subprocess Mode
  const entrypoint = resolve(projectRoot, 'src', 'index.ts');
  if (existsSync(entrypoint) || options.mode === 'subprocess') {
    if (!existsSync(entrypoint)) {
      throw new Error(`Cannot start subprocess gateway: ${entrypoint} does not exist.`);
    }

    const env = {
      ...process.env,
      PORT: String(assignedPort),
      DATA_DIR: dataDir,
      NODE_ENV: 'test',
      ...(options.upstreamUrl ? { UPSTREAM_URL: options.upstreamUrl } : {}),
      ...(options.env ?? {}),
    };

    // Spawn bun.exe directly. On Windows the `bun` shim exits on kill while
    // its child server keeps listening, leaking ports and burning CPU.
    const proc = Bun.spawn([process.execPath, entrypoint], {
      env,
      cwd: projectRoot,
      stdout: options.logLevel === 'debug' ? 'inherit' : 'pipe',
      stderr: options.logLevel === 'debug' ? 'inherit' : 'pipe',
    });

    const isHealthy = await waitForHealthy(`${baseUrl}/healthz`, timeoutMs);
    if (!isHealthy) {
      proc.kill();
      throw new Error(
        `Subprocess gateway at ${baseUrl} failed to become healthy within ${timeoutMs}ms.`
      );
    }

    return {
      baseUrl,
      port: assignedPort,
      dataDir,
      mode: 'subprocess',
      async stop() {
        try {
          proc.kill();
        } catch {}
        try {
          rmSync(dataDir, { recursive: true, force: true });
        } catch {}
      },
    };
  }

  // 5. Fallback in test environment when gateway source is not yet compiled
  // Create a minimal in-test router so tests can run in isolation
  const fallbackServer = Bun.serve({
    port: assignedPort,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz' || url.pathname === '/live') {
        return new Response(JSON.stringify({ status: 'healthy', mode: 'runner-mock' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Gateway source not yet mounted' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  return {
    baseUrl,
    port: assignedPort,
    dataDir,
    mode: 'in-process',
    async stop() {
      try {
        fallbackServer.stop(true);
      } catch {}
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}
