import { z } from 'zod';

// The schemas that get a name in the OpenAPI document live in this registry, never in zod's
// global one, so no library can add to it or clash with an id.
export const apiSchemas = z.registry<{ id: string; description?: string }>();

// Registers a schema under a component name and hands the same instance back, so the route uses
// exactly the object that was registered. zod quietly overwrites a duplicate id, so this throws
// instead. An id ending in Input is refused too, since the provider adds that suffix itself.
export function named<T extends z.ZodType>(id: string, schema: T): T {
  if (id.endsWith('Input')) throw new Error(`schema id ${id} must not end in Input`);
  if (apiSchemas._idmap.has(id)) throw new Error(`schema id ${id} is already registered`);
  apiSchemas.add(schema, { id });
  return schema;
}

export const errorBody = named('ErrorBody', z.object({ error: z.string(), message: z.string() }));
