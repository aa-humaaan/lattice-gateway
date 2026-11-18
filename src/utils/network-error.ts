import { GatewayError } from '../core/types/errors';

/** A fetch rejection is ambiguous: the upstream may have processed the request.
 *  Never rotate accounts on one — that could repeat a tool call or payment. */
export function failFastNetworkError(error: unknown): GatewayError {
  return new GatewayError(
    502,
    'bad_gateway',
    'Upstream connection failed; not switching accounts because the request may have been processed',
    { cause: error instanceof Error ? error.name : undefined }
  );
}
