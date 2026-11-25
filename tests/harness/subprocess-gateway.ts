import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { waitForHealthy } from './gateway-runner';

export interface EphemeralGateway {
  proc: ChildProcess;
  port: number;
  baseUrl: string;
}

/**
 * Spawn the gateway on an OS-assigned port and read the bound port from its
 * startup banner. Two root causes are avoided at once:
 *  - `spawn('bun', ...)` resolves to bun.cmd/bun.ps1 on Windows; killing that
 *    shim leaves the real bun.exe serving forever (port collisions, CPU leak).
 *  - bind-then-release port probing races another worker for the same port.
 */
export async function spawnGatewayOnFreePort(
  entrypoint = resolve(process.cwd(), 'src', 'index.ts'),
  extraEnv: Record<string, string> = {}
): Promise<EphemeralGateway> {
  const proc = spawn(process.execPath, [entrypoint], {
    env: { ...process.env, PORT: '0', NODE_ENV: 'test', ...extraEnv },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gateway did not report a port in 15s: ${output.slice(-400)}`)),
      15_000
    );
    proc.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Endpoint:\s+http:\/\/[^\s]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited before reporting a port (code ${code}): ${output.slice(-400)}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealthy(`${baseUrl}/healthz`, 10_000);
  if (!healthy) {
    proc.kill('SIGKILL');
    throw new Error(`gateway on ${baseUrl} never became healthy: ${output.slice(-400)}`);
  }
  return { proc, port, baseUrl };
}
