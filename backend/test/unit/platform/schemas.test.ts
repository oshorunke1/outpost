import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { apiSchemas, named } from '../../../src/platform/schemas.js';

describe('named schemas', () => {
  test('registers the exact instance it hands back under the id', () => {
    const schema = z.object({ a: z.string() });
    expect(named('SchemasTestThing', schema)).toBe(schema);
    expect(apiSchemas.get(schema)).toEqual({ id: 'SchemasTestThing' });
  });

  test('refuses a second schema under an id that is taken, where zod would overwrite it', () => {
    named('SchemasTestTaken', z.string());
    expect(() => named('SchemasTestTaken', z.number())).toThrow('schema id SchemasTestTaken is already registered');
  });

  test('refuses an id ending in Input, which would collide with the provider input names', () => {
    expect(() => named('SchemasTestInput', z.string())).toThrow('must not end in Input');
  });
});
