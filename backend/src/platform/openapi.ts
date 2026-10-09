import { readFileSync } from 'node:fs';
import fastifySwagger from '@fastify/swagger';
import { createJsonSchemaTransform, createJsonSchemaTransformObject } from 'fastify-type-provider-zod';
import type { OpenAPIV3 } from 'openapi-types';
import type { ZodApp } from './http.js';
import { addDiscriminators, decorateOperations, pruneUnreferenced } from './openapiPost.js';
import type { ResponseHeaderSpec } from './openapiPost.js';
import { apiSchemas } from './schemas.js';

declare module 'fastify' {
  interface FastifySchema {
    // Extra response headers per status code, for the OpenAPI document only. See openapiPost.ts.
    'x-response-headers'?: ResponseHeaderSpec;
  }
}

// One source for the version: backend/package.json, which sits two folders up from both
// src/platform and dist/platform, and is copied into the Docker image.
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

// The OpenAPI document is built from the route schemas, so it can never drift from what the routes
// validate. backend/scripts/export-openapi.ts writes it to contracts/openapi.yaml.
// It has to be registered before any route, because it collects routes as they are added.
// Routes declare their own security: [] when public, bearer for operator and game routes, and
// apiKey for the service key exchange. /metrics is on its own port and is not part of this API.
// Both hooks get the same registry: the transform writes the $refs, the transform object writes
// the components they point at.
export async function registerOpenApi(app: ZodApp): Promise<void> {
  const components = createJsonSchemaTransformObject({ schemaRegistry: apiSchemas });
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Outpost backend',
        version: PACKAGE_VERSION,
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
    transform: createJsonSchemaTransform({ schemaRegistry: apiSchemas }),
    transformObject: (document) => {
      const built = components(document) as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
      const paths = decorateOperations(built.paths ?? {});
      const schemas = addDiscriminators(pruneUnreferenced(paths, built.components?.schemas ?? {}));
      // The passes work on plain JSON, so the result is cast back to the document type here.
      return { ...built, paths, components: { ...built.components, schemas } } as unknown as Partial<OpenAPIV3.Document>;
    },
  });
}
