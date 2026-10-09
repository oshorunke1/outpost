import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export type ZodApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

// Lives in schemas.ts so it is a named component in the OpenAPI document.
export { errorBody } from './schemas.js';

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

export function bearerToken(header: string | undefined): string | null {
  return BEARER.exec(header ?? '')?.[1] ?? null;
}
