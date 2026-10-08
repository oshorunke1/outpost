import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { describe, expect, test } from 'vitest';
import { AppError, registerErrorHandler } from '../../../src/platform/errors.js';
import { bearerToken } from '../../../src/platform/http.js';

function makeApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  app.get('/app-error', () => {
    throw new AppError(429, 'rate_limited', 'Slow down', { headers: { 'retry-after': '7' } });
  });
  app.get('/crash', () => {
    throw new Error('database password is hunter2');
  });
  app.post('/strict', { schema: { body: z.object({ n: z.number() }) } }, (request) => ({ n: request.body.n }));
  return app;
}

describe('error handler', () => {
  test('an AppError keeps its status, code and headers', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/app-error' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    expect(response.json()).toEqual({ error: 'rate_limited', message: 'Slow down' });
  });

  test('an unexpected error is a plain 500 that leaks nothing', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/crash' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal', message: 'Internal error' });
    expect(response.body).not.toContain('hunter2');
  });

  test('a schema failure is 400 invalid_request', async () => {
    const response = await makeApp().inject({ method: 'POST', url: '/strict', payload: { n: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });

  test('an unknown route is 404 not_found', async () => {
    const response = await makeApp().inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'Route not found' });
  });
});

describe('bearerToken', () => {
  test('reads a Bearer header and nothing else', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBeNull();
    expect(bearerToken('ApiKey abc')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
