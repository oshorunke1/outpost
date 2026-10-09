import fastifySwagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { ZodApp } from './http.js';

// The OpenAPI document is built from the route schemas, so it can never drift from what the routes
// validate. backend/scripts/export-openapi.ts writes it to contracts/openapi.yaml.
// It has to be registered before any route, because it collects routes as they are added.
// Routes declare their own security: [] when public, bearer for operator and game routes, and
// apiKey for the service key exchange. /metrics is on its own port and is not part of this API.
export async function registerOpenApi(app: ZodApp): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Outpost backend',
        version: '0.2.0',
        description: 'Game backend for the Outpost Roblox framework. Generated from the route schemas. Do not edit by hand.',
        license: { name: 'MIT', url: 'https://opensource.org/license/mit' },
      },
      // The port the Compose stack publishes on the host. A deployment puts its own URL here.
      servers: [{ url: 'http://localhost:3000', description: 'Local Compose stack' }],
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'ApiKey opk_<clientId>.<secret>' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
}
