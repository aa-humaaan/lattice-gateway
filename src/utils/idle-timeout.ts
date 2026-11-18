import type { CanonicalStreamEvent } from '../core/types/canonical';

export interface IdleTimeoutOptions {
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onTimeout?: (reason: 'idle' | 'request') => void;
}

/**
 * Wraps a canonical stream so that a hung upstream cannot hold the connection
 * indefinitely. Raises a synthetic `stream_error` event if:
 *   - no event arrives within `idleTimeoutMs`, or
 *   - the total stream lifetime exceeds `requestTimeoutMs`.
 */
export function withIdleTimeout(
  source: AsyncIterable<CanonicalStreamEvent>,
  options: IdleTimeoutOptions = {}
): AsyncIterable<CanonicalStreamEvent> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 0;
  const onTimeout = options.onTimeout;
  const signal = options.signal;

  return (async function* () {
    const iterator = source[Symbol.asyncIterator]();
    const startedAt = Date.now();
    let finished = false;

    // Optional timeout signal race
    const timeoutSignal =
      requestTimeoutMs > 0 && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(requestTimeoutMs)
        : undefined;

    try {
      while (true) {
        if (signal?.aborted) {
          return;
        }

        if (timeoutSignal?.aborted || (requestTimeoutMs > 0 && Date.now() - startedAt >= requestTimeoutMs)) {
          onTimeout?.('request');
          yield {
            type: 'stream_error',
            error: {
              message: `Request exceeded maximum duration of ${requestTimeoutMs}ms`,
              type: 'gateway_timeout',
              code: 'request_timeout',
              status: 504,
            },
          };
          return;
        }

        const remainingRequestMs =
          requestTimeoutMs > 0 ? Math.max(1, requestTimeoutMs - (Date.now() - startedAt)) : undefined;
        const raceTimeoutMs =
          remainingRequestMs !== undefined ? Math.min(idleTimeoutMs, remainingRequestMs) : idleTimeoutMs;

        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortListener: (() => void) | undefined;
        let timeoutListener: (() => void) | undefined;

        const timeoutPromise = new Promise<'idle_timeout' | 'request_timeout' | 'client_abort'>((resolve) => {
          timer = setTimeout(() => {
            const isReq = remainingRequestMs !== undefined && remainingRequestMs <= idleTimeoutMs;
            resolve(isReq ? 'request_timeout' : 'idle_timeout');
          }, raceTimeoutMs);

          if (signal) {
            abortListener = () => resolve('client_abort');
            signal.addEventListener('abort', abortListener, { once: true });
          }

          if (timeoutSignal) {
            timeoutListener = () => resolve('request_timeout');
            timeoutSignal.addEventListener('abort', timeoutListener, { once: true });
          }
        });

        let nextResult: IteratorResult<CanonicalStreamEvent> | 'idle_timeout' | 'request_timeout' | 'client_abort';
        try {
          nextResult = await Promise.race([iterator.next(), timeoutPromise]);
        } finally {
          if (timer) clearTimeout(timer);
          if (signal && abortListener) signal.removeEventListener('abort', abortListener);
          if (timeoutSignal && timeoutListener) timeoutSignal.removeEventListener('abort', timeoutListener);
        }

        if (nextResult === 'client_abort') {
          return;
        }

        if (nextResult === 'request_timeout' || nextResult === 'idle_timeout') {
          const isRequestTimeout = nextResult === 'request_timeout';
          onTimeout?.(isRequestTimeout ? 'request' : 'idle');
          yield {
            type: 'stream_error',
            error: {
              message: isRequestTimeout
                ? `Request exceeded maximum duration of ${requestTimeoutMs}ms`
                : `Upstream stream idle for more than ${raceTimeoutMs}ms`,
              type: 'gateway_timeout',
              code: isRequestTimeout ? 'request_timeout' : 'stream_idle_timeout',
              status: 504,
            },
          };
          return;
        }

        if (nextResult.done) {
          finished = true;
          return;
        }

        yield nextResult.value;
      }
    } finally {
      if (!finished) {
        try {
          await iterator.return?.();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  })();
}