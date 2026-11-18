/** Accepts both RFC 7231 forms of Retry-After: delta-seconds and HTTP-date. */
export function parseRetryAfterSeconds(header: string | null | undefined, fallbackSeconds = 30): number {
  if (!header) return fallbackSeconds;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds > 0 ? seconds : fallbackSeconds;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const seconds = Math.ceil((dateMs - Date.now()) / 1000);
    return seconds > 0 ? seconds : fallbackSeconds;
  }
  return fallbackSeconds;
}
