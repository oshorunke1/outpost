import type { ZodApp } from './http.js';

// An error a route can throw on purpose. The handler turns it into { error: code, message }.
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = options.headers ?? {};
  }
}

// Fastify hands the handler an unknown error, so this is the shape we read from it.
interface FrameworkError {
  message: string;
  statusCode?: number;
  code?: string;
  validation?: unknown;
}

interface CauseSummary {
  type: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: CauseSummary;
}

// The server log gets the cause of a 5xx, but only its name, message, code and stack, a few levels
// deep. Client libraries hang extra fields on their errors (the failed command and its arguments,
// a request object), and those can carry request data such as a password, so none of them are copied.
export function summarizeCause(cause: unknown, depth = 0): CauseSummary | undefined {
  if (cause === undefined || cause === null || depth >= 3) return undefined;
  if (!(cause instanceof Error)) return { type: typeof cause, message: '[non-error cause]' };
  const code = (cause as { code?: unknown }).code;
  const summary: CauseSummary = { type: cause.name, message: cause.message };
  if (typeof code === 'string') summary.code = code;
  if (cause.stack) summary.stack = cause.stack;
  const inner = summarizeCause(cause.cause, depth + 1);
  if (inner) summary.cause = inner;
  return summary;
}

const STABLE_4XX_CODES: Record<number, string> = {
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

export function registerErrorHandler(app: ZodApp): void {
  app.setErrorHandler((caught: unknown, request, reply) => {
    const error = caught as FrameworkError;
    if (caught instanceof AppError) {
      if (caught.statusCode >= 500) request.log.error({ code: caught.code, cause: summarizeCause(caught.cause) }, caught.message);
      return reply.code(caught.statusCode).headers(caught.headers).send({ error: caught.code, message: caught.message });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: error.message });
    }
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) {
      request.log.error({ err: summarizeCause(caught) }, 'unhandled error');
      return reply.code(500).send({ error: 'internal', message: 'Internal error' });
    }
    // Framework codes (FST_ERR_...) are internals, so clients get a small fixed set instead.
    return reply.code(status).send({ error: STABLE_4XX_CODES[status] ?? 'bad_request', message: error.message });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found', message: 'Route not found' }));
}
