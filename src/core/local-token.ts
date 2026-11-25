import { loadOrCreateAuthTokens } from './auth-tokens';
import { loadConfig } from './config';

/** The real gateway bearer token for local tool configs. Generated on first
 *  run and stored outside version control; never a hard-coded literal. */
export function gatewayBearerToken(): string {
  return loadOrCreateAuthTokens(process.env.DATA_DIR || 'data').gatewayToken;
}

/** The token the running gateway actually accepts. Mirrors how the entrypoints
 *  build config: LATTICE_GATEWAY_TOKEN wins over the generated token. */
export function effectiveGatewayToken(): string {
  return loadConfig({ gatewayToken: gatewayBearerToken() }).gatewayToken!;
}
