import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

export type ZodApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export const errorBody = z.object({ error: z.string(), message: z.string() });

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

export function bearerToken(header: string | undefined): string | null {
  return BEARER.exec(header ?? '')?.[1] ?? null;
}
