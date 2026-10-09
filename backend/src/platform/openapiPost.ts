// Finishing passes over the generated OpenAPI document. They run in the swagger transformObject
// hook, after every route is in, and each one builds fresh objects so the YAML gets no new anchors.

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const COMPONENT_PREFIX = '#/components/schemas/';

// Every $ref string found anywhere under value.
function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, into);
    return;
  }
  if (!isNode(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith(COMPONENT_PREFIX)) into.add(child.slice(COMPONENT_PREFIX.length));
    else collectRefs(child, into);
  }
}

// The provider emits every registered schema twice, X for responses and XInput for requests.
// This keeps only the components the paths reach, directly or through other components, in the
// order they were registered.
export function pruneUnreferenced(paths: unknown, schemas: Node): Node {
  const reached = new Set<string>();
  collectRefs(paths, reached);
  const queue = [...reached];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const found = new Set<string>();
    collectRefs(schemas[name], found);
    for (const next of found) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return Object.fromEntries(Object.entries(schemas).filter(([name]) => reached.has(name)));
}

// The single literal value an arm pins a property to, if it does.
function pinnedValue(arm: unknown, property: string): string | undefined {
  if (!isNode(arm) || !isNode(arm.properties)) return undefined;
  const schema = arm.properties[property];
  if (!isNode(schema) || !Array.isArray(schema.enum) || schema.enum.length !== 1) return undefined;
  const [value] = schema.enum as unknown[];
  return typeof value === 'string' ? value : undefined;
}

// zod writes a discriminated union as a plain oneOf. When every arm is a named component that pins
// the same property to its own literal, this adds the discriminator, so client generators can pick
// the arm by that property instead of trying each one.
export function addDiscriminators(schemas: Node): Node {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      if (!isNode(schema) || !Array.isArray(schema.oneOf) || schema.oneOf.length < 2) return [name, schema];
      const refs = (schema.oneOf as unknown[]).map((arm) => (isNode(arm) && typeof arm.$ref === 'string' ? arm.$ref : undefined));
      if (refs.some((ref) => ref === undefined || !ref.startsWith(COMPONENT_PREFIX))) return [name, schema];
      const arms = (refs as string[]).map((ref) => schemas[ref.slice(COMPONENT_PREFIX.length)]);
      const first = arms[0];
      const candidates = isNode(first) && isNode(first.properties) ? Object.keys(first.properties) : [];
      for (const property of candidates) {
        const values = arms.map((arm) => pinnedValue(arm, property));
        if (values.some((value) => value === undefined) || new Set(values).size !== values.length) continue;
        const mapping = Object.fromEntries(values.map((value, index) => [value as string, refs[index] as string]));
        return [name, { ...schema, discriminator: { propertyName: property, mapping } }];
      }
      return [name, schema];
    }),
  );
}

// Response headers a route can send. A route lists the extra ones per status code with
// x-response-headers; every 429 gets retry-after without being asked, since every limiter sets it.
export const RESPONSE_HEADERS = {
  'retry-after': { description: 'Whole seconds to wait before retrying', schema: { type: 'integer', minimum: 0 } },
  'idempotent-replayed': { description: 'Present when this answer is the stored result of an earlier request with the same Idempotency-Key', schema: { type: 'string', enum: ['true'] } },
} as const;
export type ResponseHeaderName = keyof typeof RESPONSE_HEADERS;
// always means every response with that status carries the header, sometimes means only some do.
export type ResponseHeaderSpec = Partial<Record<number, Partial<Record<ResponseHeaderName, 'always' | 'sometimes'>>>>;
export const RESPONSE_HEADERS_KEY = 'x-response-headers';

const DESCRIPTIONS: Record<string, string> = {
  '200': 'OK',
  '201': 'Created',
  '202': 'Accepted',
  '204': 'Done, no body',
  '400': 'The request is malformed or fails validation',
  '401': 'Missing or invalid credentials',
  '403': 'The token lacks the scope this route needs',
  '404': 'Not found',
  '409': 'Conflicts with an earlier request',
  '413': 'The body is over the size limit',
  '422': 'Refused by a business rule, for example not enough Coins',
  '429': 'Rate limited, wait for Retry-After',
  '503': 'A dependency is unavailable, retry later',
};

function headerObject(name: ResponseHeaderName, presence: 'always' | 'sometimes'): Node {
  const { description, schema } = RESPONSE_HEADERS[name];
  return { description, required: presence === 'always', schema: JSON.parse(JSON.stringify(schema)) as unknown };
}

// Gives every response a real description, adds the headers each operation declares, and drops
// the x-response-headers marker so it never shows in the document.
export function decorateOperations(paths: Node): Node {
  return Object.fromEntries(
    Object.entries(paths).map(([path, item]) => {
      if (!isNode(item)) return [path, item];
      const operations = Object.entries(item).map(([method, value]) => {
        if (!isNode(value) || !isNode(value.responses)) return [method, value];
        const { [RESPONSE_HEADERS_KEY]: declared, ...operation } = value;
        const spec = (isNode(declared) ? declared : {}) as Record<string, Partial<Record<ResponseHeaderName, 'always' | 'sometimes'>>>;
        const responses = Object.fromEntries(
          Object.entries(value.responses).map(([code, response]) => {
            if (!isNode(response)) return [code, response];
            const wanted: Partial<Record<ResponseHeaderName, 'always' | 'sometimes'>> = { ...(code === '429' ? { 'retry-after': 'always' } : {}), ...spec[code] };
            const names = Object.keys(wanted) as ResponseHeaderName[];
            const headers = names.length === 0 ? {} : { headers: Object.fromEntries(names.map((name) => [name, headerObject(name, wanted[name] ?? 'sometimes')])) };
            const description = response.description === 'Default Response' ? (DESCRIPTIONS[code] ?? response.description) : response.description;
            return [code, { ...response, description, ...headers }];
          }),
        );
        return [method, { ...operation, responses }];
      });
      return [path, Object.fromEntries(operations)];
    }),
  );
}
