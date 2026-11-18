/** Formats a port-conflict message. If the runtime error carries a PID, name
 *  it so the operator can investigate; otherwise say so plainly. Never kills
 *  the owning process — that is the operator's call. */
export function formatPortConflict(port: number, error: unknown): string {
  const candidate = error as { pid?: unknown; message?: unknown } | null;
  const pid = candidate?.pid ?? (typeof candidate?.message === 'string'
    ? candidate.message.match(/\bpid\s[:=]?\s*(\d+)\b/i)?.[1]
    : undefined);
  const owner = pid !== undefined && pid !== null ? ` (PID ${pid})` : ' (owner PID not reported by this runtime)';
  return `Port ${port} is already in use${owner}. Lattice will not terminate that process.`;
}
