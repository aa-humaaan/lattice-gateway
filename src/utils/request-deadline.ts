import { GatewayError } from '../core/types/errors';

/** Applies the configured request deadline to non-streaming upstream calls. */
export function withRequestDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new GatewayError(504, 'gateway_timeout', `${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
