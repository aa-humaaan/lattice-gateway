import { loadOrCreateAuthTokens } from './auth-tokens';

/** The real gateway bearer token for local tool configs. Generated on first
 *  run and stored outside version control; never a hard-coded literal. */
export function gatewayBearerToken(): string {
  return loadOrCreateAuthTokens(process.env.DATA_DIR || 'data').gatewayToken;
}
