import { GatewayError } from '../core/types/errors';

/**
 * Applies the configured request deadline to non-streaming upstream calls.
 * When a controller is supplied the deadline aborts it, so the upstream fetch
 * stops instead of lingering after the caller has already given up.
 */
export function withRequestDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  controller?: AbortController,
  signal?: AbortSignal
): Promise<T> {
  // A client cancellation must reach the upstream even when deadlines are off.
  let abortListener: (() => void) | undefined;
  if (controller && signal) {
    if (signal.aborted) controller.abort();
    else {
      abortListener = () => controller.abort();
      signal.addEventListener('abort', abortListener, { once: true });
    }
  }
  const cleanup = () => {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  };

  if (!timeoutMs || timeoutMs <= 0) return work.finally(cleanup);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new GatewayError(504, 'gateway_timeout', `${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
    cleanup();
  });
}
