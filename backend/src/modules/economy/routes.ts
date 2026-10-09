import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { errorBody } from '../../platform/http.js';
import type { ZodApp } from '../../platform/http.js';
import type { Metrics } from '../../platform/metrics.js';
import { requireService } from '../identity/guards.js';
import type { GuardFor } from '../identity/guards.js';
import { userIdBody, userIdParams } from '../players/params.js';
import { ITEM_IDS } from './catalog.js';
import { LEDGER_ERROR_CODES } from './ledger.js';
import type { LedgerService } from './ledger.js';
import { EARN_REASONS, MAX_EARN_PER_TRANSACTION } from './plan.js';

// Strict on both arms, so a client-sent price, balance or anything else extra is a 400 instead of
// being quietly dropped. The backend is the only price authority.
const transactionBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('earn'), userId: userIdBody, amount: z.number().int().min(1).max(MAX_EARN_PER_TRANSACTION), reason: z.enum(EARN_REASONS) }).strict(),
  z.object({ kind: z.literal('purchase'), userId: userIdBody, itemId: z.enum(ITEM_IDS) }).strict(),
]);

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,128}$/;

// Loose, so the Authorization header the guard already read is not stripped from the request.
const idempotencyHeaders = z.looseObject({ 'idempotency-key': z.string().regex(IDEMPOTENCY_KEY) });

// The ledger stores each result as MySQL JSON, which hands keys back in its own order. Serializing
// through this schema fixes the order, so a replay is byte for byte the first answer apart from
// replayed itself.
const transactionReply = z.object({
  transactionId: z.uuid(),
  kind: z.enum(['earn', 'purchase', 'refund']),
  userId: z.number().int(),
  amount: z.number().int(),
  balanceAfter: z.number().int(),
  itemId: z.enum(ITEM_IDS).nullable(),
  createdAt: z.string(),
  replayed: z.boolean(),
});

const purchase = z.object({ transactionId: z.uuid(), itemId: z.enum(ITEM_IDS), createdAt: z.string() });
const errors = { 400: errorBody, 401: errorBody, 403: errorBody, 404: errorBody, 409: errorBody, 422: errorBody, 429: errorBody, 503: errorBody };
const bearer = [{ bearer: [] }];

// The ledger records who wrote each transaction under this name.
const ledgerPrincipal = (clientId: string) => `svc:${clientId}`;

export function registerEconomyRoutes(app: ZodApp, deps: { ledger: LedgerService; metrics: Metrics; guardFor: GuardFor }): void {
  const economy = deps.guardFor('game:economy');

  app.post(
    '/v1/economy/transactions',
    {
      onRequest: economy,
      schema: {
        tags: ['economy'],
        summary: 'Earn or purchase. Retrying with the same Idempotency-Key returns the first result.',
        security: bearer,
        headers: idempotencyHeaders,
        body: transactionBody,
        response: { 200: transactionReply, 201: transactionReply, ...errors },
      },
    },
    async (request, reply) => {
      const principal = requireService(request);
      const kind = request.body.kind;
      let outcome;
      try {
        outcome = await deps.ledger.submit({
          principal: ledgerPrincipal(principal.clientId),
          idempotencyKey: request.headers['idempotency-key'],
          request: request.body,
        });
      } catch (error) {
        // Only the ledger's own codes become label values; anything else is other, never its message.
        const known = error instanceof AppError && Object.hasOwn(LEDGER_ERROR_CODES, error.code);
        deps.metrics.ledgerTransactions.inc({ kind, outcome: known ? error.code : 'other' });
        throw error;
      }
      deps.metrics.ledgerTransactions.inc({ kind, outcome: outcome.replayed ? 'replayed' : 'created' });
      if (outcome.replayed) {
        deps.metrics.idempotentReplays.inc();
        void reply.header('idempotent-replayed', 'true');
      }
      return reply.code(outcome.replayed ? 200 : 201).send({ ...outcome.result, replayed: outcome.replayed });
    },
  );

  app.post(
    '/v1/economy/transactions/:id/fulfilled',
    {
      onRequest: economy,
      schema: {
        tags: ['economy'],
        summary: 'The game granted the purchased item. Safe to repeat. Only the client that made the purchase can acknowledge it.',
        security: bearer,
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      const principal = requireService(request);
      // Someone else's purchase answers the same 404 as a missing one, so ids do not leak.
      await deps.ledger.markFulfilled(request.params.id, ledgerPrincipal(principal.clientId));
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/v1/players/:userId/purchases',
    {
      onRequest: economy,
      schema: {
        tags: ['economy'],
        summary: 'Purchases the game has not acknowledged yet, for the reconcile on join',
        security: bearer,
        params: userIdParams,
        querystring: z.object({ unfulfilled: z.literal('1') }).strict(),
        response: { 200: z.object({ purchases: z.array(purchase) }), ...errors },
      },
    },
    async (request) => ({ purchases: await deps.ledger.unfulfilledPurchases(request.params.userId) }),
  );
}
