import { z } from 'zod';
import { redactSecrets } from '../../utils/redact';

// ============================================================================
// Error Classification & Categories
// ============================================================================

export type ErrorCategory =
  | 'invalid_request'      // HTTP 400
  | 'authentication'       // HTTP 401
  | 'permission_denied'    // HTTP 403
  | 'not_found'            // HTTP 404
  | 'rate_limit'           // HTTP 429
  | 'upstream_error'       // HTTP 500
  | 'bad_gateway'          // HTTP 502
  | 'service_unavailable'  // HTTP 503
  | 'gateway_timeout'      // HTTP 504
  | 'internal_error';      // Gateway internal bug

export const ErrorCategorySchema = z.enum([
  'invalid_request',
  'authentication',
  'permission_denied',
  'not_found',
  'rate_limit',
  'upstream_error',
  'bad_gateway',
  'service_unavailable',
  'gateway_timeout',
  'internal_error',
]);

// ============================================================================
// GatewayError Base Class & Overloads
// ============================================================================

export interface GatewayErrorOptions {
  category?: ErrorCategory;
  status?: number;
  statusCode?: number;
  code?: string;
  param?: string | null;
  retryAfterMs?: number;
  retryAfter?: number;
  providerId?: string;
  accountId?: string;
  reqId?: string;
  cause?: unknown;
}

export function inferCategoryFromStatus(status: number): ErrorCategory {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'authentication';
    case 403:
      return 'permission_denied';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limit';
    case 502:
      return 'bad_gateway';
    case 503:
      return 'service_unavailable';
    case 504:
      return 'gateway_timeout';
    default:
      return status >= 500 ? 'upstream_error' : 'internal_error';
  }
}

export class GatewayError extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  readonly statusCode: number;
  readonly code: string;
  readonly param?: string | null;
  readonly retryAfterMs?: number;
  readonly retryAfter?: number;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly reqId?: string;

  constructor(message: string, options: GatewayErrorOptions);
  constructor(statusCode: number, code: string, message: string, options?: Partial<GatewayErrorOptions>);
  constructor(
    arg1: string | number,
    arg2?: GatewayErrorOptions | string,
    arg3?: string,
    arg4?: Partial<GatewayErrorOptions>
  ) {
    let msg: string;
    let status = 500;
    let code = 'internal_error';
    let opts: Partial<GatewayErrorOptions> = {};

    if (typeof arg1 === 'number') {
      status = arg1;
      code = typeof arg2 === 'string' ? arg2 : 'error';
      msg = arg3 ?? 'An error occurred';
      opts = arg4 ?? {};
    } else {
      msg = arg1;
      opts = (arg2 as GatewayErrorOptions) ?? {};
      status = opts.status ?? opts.statusCode ?? 500;
      code = opts.code ?? 'error';
    }

    super(redactSecrets(msg));
    this.name = 'GatewayError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.category = opts.category ?? inferCategoryFromStatus(status);
    this.param = opts.param;
    this.retryAfter = opts.retryAfter ?? (opts.retryAfterMs ? Math.ceil(opts.retryAfterMs / 1000) : undefined);
    this.retryAfterMs = opts.retryAfterMs ?? (opts.retryAfter ? opts.retryAfter * 1000 : undefined);
    this.providerId = opts.providerId;
    this.accountId = opts.accountId;
    this.reqId = opts.reqId;
    if (opts.cause) {
      this.cause = opts.cause;
    }
  }
}

// ============================================================================
// Dialect Wire Formats for Errors
// ============================================================================

export interface OpenAIErrorWirePayload {
  error: {
    message: string;
    type:
      | 'invalid_request_error'
      | 'authentication_error'
      | 'permission_denied_error'
      | 'not_found_error'
      | 'rate_limit_error'
      | 'api_error';
    param: string | null;
    code: string | null;
  };
}

export interface AnthropicErrorWirePayload {
  type: 'error';
  error: {
    type:
      | 'invalid_request_error'
      | 'authentication_error'
      | 'permission_error'
      | 'not_found_error'
      | 'rate_limit_error'
      | 'api_error'
      | 'overloaded_error';
    message: string;
  };
}

export interface ResponsesErrorWirePayload {
  id: string;
  object: 'response';
  status: 'failed';
  error: {
    code: string;
    message: string;
  };
}

// ============================================================================
// Error Serialization Helpers
// ============================================================================

export function toOpenAIError(error: unknown): { status: number; payload: OpenAIErrorWirePayload } {
  if (error instanceof GatewayError) {
    let type: OpenAIErrorWirePayload['error']['type'] = 'api_error';
    switch (error.category) {
      case 'invalid_request':
        type = 'invalid_request_error';
        break;
      case 'authentication':
        type = 'authentication_error';
        break;
      case 'permission_denied':
        type = 'permission_denied_error';
        break;
      case 'not_found':
        type = 'not_found_error';
        break;
      case 'rate_limit':
        type = 'rate_limit_error';
        break;
      default:
        type = 'api_error';
    }
    return {
      status: error.status,
      payload: {
        error: {
          message: error.message,
          type,
          param: error.param ?? null,
          code: error.code,
        },
      },
    };
  }

  const message = redactSecrets(error instanceof Error ? error.message : 'Internal Server Error');
  return {
    status: 500,
    payload: {
      error: {
        message,
        type: 'api_error',
        param: null,
        code: 'internal_error',
      },
    },
  };
}

export function toAnthropicError(error: unknown): { status: number; payload: AnthropicErrorWirePayload } {
  if (error instanceof GatewayError) {
    let type: AnthropicErrorWirePayload['error']['type'] = 'api_error';
    switch (error.category) {
      case 'invalid_request':
        type = 'invalid_request_error';
        break;
      case 'authentication':
        type = 'authentication_error';
        break;
      case 'permission_denied':
        type = 'permission_error';
        break;
      case 'not_found':
        type = 'not_found_error';
        break;
      case 'rate_limit':
        type = 'rate_limit_error';
        break;
      case 'service_unavailable':
        type = 'overloaded_error';
        break;
      default:
        type = 'api_error';
    }
    return {
      status: error.status,
      payload: {
        type: 'error',
        error: {
          type,
          message: error.message,
        },
      },
    };
  }

  const message = redactSecrets(error instanceof Error ? error.message : 'Internal Server Error');
  return {
    status: 500,
    payload: {
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    },
  };
}

export function toResponsesError(error: unknown): { status: number; payload: ResponsesErrorWirePayload } {
  const code = error instanceof GatewayError ? error.code : 'internal_error';
  const message = redactSecrets(error instanceof Error ? error.message : 'Internal Server Error');
  const status = error instanceof GatewayError ? error.status : 500;

  return {
    status,
    payload: {
      id: `resp_err_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      object: 'response',
      status: 'failed',
      error: {
        code,
        message,
      },
    },
  };
}

export function serializeDialectError(
  error: unknown,
  dialect: 'openai' | 'anthropic' | 'responses'
): OpenAIErrorWirePayload | AnthropicErrorWirePayload | ResponsesErrorWirePayload {
  if (dialect === 'anthropic') {
    return toAnthropicError(error).payload;
  }
  if (dialect === 'responses') {
    return toResponsesError(error).payload;
  }
  return toOpenAIError(error).payload;
}
