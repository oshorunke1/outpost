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

export function registerErrorHandler(app: ZodApp): void {
  app.setErrorHandler((caught: unknown, request, reply) => {
    const error = caught as FrameworkError;
    if (caught instanceof AppError) {
      if (caught.statusCode >= 500) request.log.error({ err: caught, cause: caught.cause }, caught.message);
      return reply.code(caught.statusCode).headers(caught.headers).send({ error: caught.code, message: caught.message });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: error.message });
    }
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(500).send({ error: 'internal', message: 'Internal error' });
    }
    return reply.code(status).send({ error: (error.code ?? 'bad_request').toLowerCase(), message: error.message });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found', message: 'Route not found' }));
}
