import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { checkContract, renderContract } from '../../scripts/openapiContract.js';
import { buildApp } from '../../src/app.js';
import { createMemoryAppDeps } from '../../src/memoryDeps.js';

interface Media {
  schema: { $ref?: string };
}
interface Response {
  description: string;
  content?: Record<string, Media>;
  headers?: Record<string, { description?: string; required?: boolean; schema: { type: string } }>;
}
interface Operation {
  operationId?: string;
  summary?: string;
  security?: unknown[];
  parameters?: { in: string; name: string; required?: boolean }[];
  requestBody?: { content: Record<string, Media> };
  responses: Record<string, Response>;
}
interface OpenApiDoc {
  openapi: string;
  info: { version: string; license?: { name: string } };
  servers?: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, { oneOf?: unknown[]; discriminator?: { propertyName: string; mapping?: Record<string, string> } }>;
  };
}

async function document(): Promise<OpenApiDoc> {
  const app = await buildApp((await createMemoryAppDeps()).deps);
  await app.ready();
  const doc = app.swagger() as unknown as OpenApiDoc;
  await app.close();
  return doc;
}

function operations(doc: OpenApiDoc): [string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => [`${method} ${path}`, op] as [string, Operation]));
}

const ref = (name: string) => `#/components/schemas/${name}`;
const jsonRef = (media: Record<string, Media> | undefined) => media?.['application/json']?.schema.$ref;
const byId = (doc: OpenApiDoc, id: string) => operations(doc).find(([, operation]) => operation.operationId === id)?.[1];

const PUBLIC_PATHS = ['/.well-known/jwks.json', '/auth/login', '/auth/token/refresh', '/healthz', '/readyz'];

describe('the OpenAPI document', () => {
  test('lists every M2 route and nothing else, with metrics left off (its own port)', async () => {
    const doc = await document();
    expect(doc.openapi.startsWith('3.')).toBe(true);
    expect(doc.info.license?.name).toBe('MIT');
    expect(doc.servers?.map((server) => server.url)).toEqual(['http://localhost:3000']);
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/.well-known/jwks.json',
      '/auth/login',
      '/auth/logout',
      '/auth/logout/all',
      '/auth/service-token',
      '/auth/sessions',
      '/auth/sessions/{id}',
      '/auth/token/refresh',
      '/healthz',
      '/readyz',
      '/v1/economy/transactions',
      '/v1/economy/transactions/{id}/fulfilled',
      '/v1/flags',
      '/v1/players/{userId}/purchases',
      '/v1/players/{userId}/sessions',
      '/v1/players/{userId}/sessions/end',
      '/v1/players/{userId}/wallet',
      '/v1/telemetry/batch',
    ]);
    expect(doc.components.securitySchemes).toEqual({
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKey: expect.objectContaining({ type: 'apiKey', in: 'header', name: 'Authorization' }) as unknown,
    });
  });

  test('every game route declares bearer security and the transaction route requires Idempotency-Key', async () => {
    const doc = await document();
    const game = operations(doc).filter(([name]) => name.split(' ')[1]?.startsWith('/v1/'));
    expect(game).toHaveLength(8);
    for (const [name, operation] of game) expect(operation.security, name).toEqual([{ bearer: [] }]);
    const header = doc.paths['/v1/economy/transactions']?.post?.parameters?.find((p) => p.in === 'header' && p.name === 'idempotency-key');
    expect(header?.required).toBe(true);
  });

  test('public routes declare no security, operator routes bearer, and the key exchange apiKey', async () => {
    const doc = await document();
    for (const path of PUBLIC_PATHS) {
      for (const [method, operation] of Object.entries(doc.paths[path] ?? {})) expect(operation.security, `${method} ${path}`).toEqual([]);
    }
    expect(doc.paths['/auth/service-token']?.post?.security).toEqual([{ apiKey: [] }]);
    for (const [path, method] of [
      ['/auth/logout', 'post'],
      ['/auth/logout/all', 'post'],
      ['/auth/sessions', 'get'],
      ['/auth/sessions/{id}', 'delete'],
    ] as const) {
      expect(doc.paths[path]?.[method]?.security, `${method} ${path}`).toEqual([{ bearer: [] }]);
    }
  });

  test('every operation has a summary and a unique camelCase operationId', async () => {
    const doc = await document();
    const all = operations(doc);
    expect(all).toHaveLength(18);
    const ids = all.map(([name, operation]) => {
      expect(operation.summary, name).toMatch(/\S/);
      expect(operation.operationId, name).toMatch(/^[a-z][A-Za-z0-9]*$/);
      return operation.operationId;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the OpenAPI document, schemas and responses', () => {
  test('names exactly the shared schemas as components, with no unused input or output twin', async () => {
    const doc = await document();
    expect(Object.keys(doc.components.schemas).sort()).toEqual(
      [
        'EarnRequestInput',
        'ErrorBody',
        'Flags',
        'Health',
        'Jwk',
        'JwkSet',
        'LoginRequestInput',
        'Purchase',
        'PurchaseList',
        'PurchaseRequestInput',
        'Readiness',
        'RefreshRequestInput',
        'ServiceToken',
        'Session',
        'SessionList',
        'TelemetryAccepted',
        'TelemetryBatchInput',
        'TokenPair',
        'TransactionRequestInput',
        'TransactionResult',
        'Wallet',
      ].sort(),
    );
  });

  test('request bodies and responses refer to the named components', async () => {
    const doc = await document();
    const submit = byId(doc, 'submitTransaction');
    expect(jsonRef(submit?.requestBody?.content)).toBe(ref('TransactionRequestInput'));
    expect(jsonRef(submit?.responses['200']?.content)).toBe(ref('TransactionResult'));
    expect(jsonRef(submit?.responses['201']?.content)).toBe(ref('TransactionResult'));
    expect(jsonRef(submit?.responses['422']?.content)).toBe(ref('ErrorBody'));
    expect(jsonRef(byId(doc, 'login')?.requestBody?.content)).toBe(ref('LoginRequestInput'));
    expect(jsonRef(byId(doc, 'login')?.responses['200']?.content)).toBe(ref('TokenPair'));
    expect(jsonRef(byId(doc, 'submitTelemetryBatch')?.requestBody?.content)).toBe(ref('TelemetryBatchInput'));
    expect(jsonRef(byId(doc, 'getWallet')?.responses['200']?.content)).toBe(ref('Wallet'));
  });

  test('the earn or purchase union carries a discriminator on kind', async () => {
    const doc = await document();
    const union = doc.components.schemas.TransactionRequestInput;
    expect(union?.oneOf).toEqual([{ $ref: ref('EarnRequestInput') }, { $ref: ref('PurchaseRequestInput') }]);
    expect(union?.discriminator).toEqual({
      propertyName: 'kind',
      mapping: { earn: ref('EarnRequestInput'), purchase: ref('PurchaseRequestInput') },
    });
  });

  test('every 204 documents no body', async () => {
    const doc = await document();
    const empty = operations(doc).filter(([, operation]) => operation.responses['204']);
    expect(empty.map(([name]) => name).sort()).toEqual([
      'delete /auth/sessions/{id}',
      'post /auth/logout',
      'post /auth/logout/all',
      'post /v1/economy/transactions/{id}/fulfilled',
      'post /v1/players/{userId}/sessions/end',
    ]);
    for (const [name, operation] of empty) expect(operation.responses['204']?.content, name).toBeUndefined();
  });

  test('game routes declare every guard failure, and routes with a body declare 400 and 413', async () => {
    const doc = await document();
    for (const [name, operation] of operations(doc)) {
      const codes = Object.keys(operation.responses);
      if (name.split(' ')[1]?.startsWith('/v1/')) expect(codes, name).toEqual(expect.arrayContaining(['401', '403', '429', '503']));
      if (operation.requestBody) expect(codes, name).toEqual(expect.arrayContaining(['400', '413']));
    }
  });

  test('errors a route cannot return are not declared', async () => {
    const doc = await document();
    for (const id of ['markPurchaseFulfilled', 'listUnfulfilledPurchases']) {
      const codes = Object.keys(byId(doc, id)?.responses ?? {});
      expect(codes, id).not.toContain('409');
      expect(codes, id).not.toContain('422');
    }
  });

  test('retry-after is documented on every 429 and on the retryable 503s, idempotent-replayed on the replay', async () => {
    const doc = await document();
    for (const [name, operation] of operations(doc)) {
      const limited = operation.responses['429'];
      if (limited) expect(limited.headers?.['retry-after'], name).toMatchObject({ required: true, schema: { type: 'integer' } });
    }
    for (const id of ['submitTransaction', 'listFlags']) {
      expect(byId(doc, id)?.responses['503']?.headers?.['retry-after'], id).toMatchObject({ schema: { type: 'integer' } });
    }
    expect(byId(doc, 'submitTransaction')?.responses['200']?.headers?.['idempotent-replayed']).toMatchObject({ required: true });
    expect(byId(doc, 'submitTransaction')?.responses['201']?.headers).toBeUndefined();
  });

  test('every response has a real description', async () => {
    const doc = await document();
    for (const [name, operation] of operations(doc)) {
      for (const [code, response] of Object.entries(operation.responses)) expect(response.description, `${name} ${code}`).not.toBe('Default Response');
    }
  });

  test('the document version is the backend package version', async () => {
    const doc = await document();
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(doc.info.version).toBe(pkg.version);
  });
});

describe('the contract drift check', () => {
  const scratch = () => join(mkdtempSync(join(tmpdir(), 'outpost-openapi-')), 'openapi.yaml');

  test('renders a header and YAML that starts with the OpenAPI version, the same twice', async () => {
    const first = await renderContract();
    expect(first.startsWith('# Generated by backend/scripts/export-openapi.ts')).toBe(true);
    expect(first).toMatch(/\nopenapi: 3\./);
    expect(await renderContract()).toBe(first);
  });

  test('a matching file is current', () => {
    const target = scratch();
    writeFileSync(target, 'same');
    expect(checkContract(target, 'same')).toEqual({ ok: true, message: 'contracts/openapi.yaml is current' });
  });

  test('a changed file is stale with a fix-it message', () => {
    const target = scratch();
    writeFileSync(target, 'old');
    const result = checkContract(target, 'new');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/is stale\. Run npx --yes pnpm@10\.34\.6 --filter @outpost\/backend openapi:export and commit it\./);
  });

  test('a missing file is stale too, with no raw ENOENT', () => {
    const result = checkContract(join(tmpdir(), 'outpost-openapi-missing', 'openapi.yaml'), 'new');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/is missing\. Run .* openapi:export and commit it\./);
    expect(result.message).not.toMatch(/ENOENT/);
  });

  // CI gates on the exit code, so the real script is run, not just the helper.
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/export-openapi.ts', ...args], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
    });

  test('the CLI exits 0 when current, and 1 when stale or missing', { timeout: 60_000 }, () => {
    const target = scratch();
    expect(cli('--check', '--target', target).status).toBe(1);
    expect(cli('--target', target).status).toBe(0);
    const current = cli('--check', '--target', target);
    expect({ status: current.status, out: current.stdout.trim() }).toEqual({ status: 0, out: 'contracts/openapi.yaml is current' });
    writeFileSync(target, readFileSync(target, 'utf8').replace('title: Outpost backend', 'title: edited'));
    const stale = cli('--check', '--target', target);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('is stale');
  });
});
