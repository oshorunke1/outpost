import { createHash } from 'node:crypto';

// Thrown for any value canonical JSON refuses. It extends TypeError, so callers that only care
// that the input was not JSON can still catch TypeError.
export class CanonicalJsonError extends TypeError {
  override name = 'CanonicalJsonError';
}

// JSON with object keys sorted at every level, so equal values always give equal text and
// equal hashes. Used for idempotency request hashes and telemetry dimension keys.
//
// The rules, chosen so two different values can never share one encoding:
// - only null, booleans, finite numbers, strings, arrays and plain objects are accepted
// - NaN, Infinity, BigInt, functions, symbols, Dates, Maps, Sets, class instances, symbol keys
//   and cycles throw CanonicalJsonError (JSON.stringify would quietly turn some of these into
//   null, {} or a string, which would make two different requests hash the same)
// - an object member whose value is undefined is dropped, as JSON.stringify does
// - an undefined array element or a sparse array hole throws, since JSON.stringify would write
//   null and [undefined] is not the same request as [null]
// - arrays keep their order, object keys sort by UTF-16 code unit (JavaScript's own < on strings)
// - -0 encodes as 0, as JSON.stringify does
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>(), '$');
}

function encode(value: unknown, ancestors: Set<object>, path: string): string {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`canonicalJson cannot encode ${value} at ${path}`);
      return JSON.stringify(value);
    case 'object':
      if (value === null) return 'null';
      return encodeContainer(value, ancestors, path);
    default:
      // undefined, bigint, symbol and function
      throw new CanonicalJsonError(`canonicalJson cannot encode a ${typeof value} at ${path}`);
  }
}

function encodeContainer(value: object, ancestors: Set<object>, path: string): string {
  if (ancestors.has(value)) throw new CanonicalJsonError(`canonicalJson cannot encode a circular value at ${path}`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (item === undefined) throw new CanonicalJsonError(`canonicalJson cannot encode an undefined array element at ${path}[${index}]`);
        items.push(encode(item, ancestors, `${path}[${index}]`));
      }
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(`canonicalJson only encodes plain objects, got ${value.constructor?.name ?? 'an exotic object'} at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalJsonError(`canonicalJson cannot encode symbol keys at ${path}`);
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${encode(member, ancestors, `${path}.${key}`)}`);
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value); // only ancestors count, so a value shared by two siblings is fine
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
