import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { CanonicalJsonError, canonicalJson, sha256Hex } from '../../../src/platform/canonicalJson.js';

describe('canonicalJson', () => {
  test('sorts keys at every level and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  test('key order never changes the hash', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(sha256Hex(canonicalJson(reversed))).toBe(sha256Hex(canonicalJson(record)));
      }),
    );
  });

  test('nested objects with the same content in a different key order hash the same', () => {
    const first = { user: { id: 7, name: 'a' }, items: [{ qty: 1, sku: 'x' }], kind: 'earn' };
    const second = { kind: 'earn', items: [{ sku: 'x', qty: 1 }], user: { name: 'a', id: 7 } };
    expect(sha256Hex(canonicalJson(second))).toBe(sha256Hex(canonicalJson(first)));
  });

  test('the output is always valid JSON that parses back to the same value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });

  test('arrays keep their order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  // '￿' is one code unit above every surrogate, so code point order would put it after an
  // emoji and code unit order puts it before. JavaScript's own < compares code units.
  test('keys sort by UTF-16 code unit', () => {
    expect(canonicalJson({ '￿': 1, '\u{1F600}': 2, B: 3, a: 4 })).toBe('{"B":3,"a":4,"\u{1F600}":2,"￿":1}');
  });

  test('refuses values JSON cannot hold', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });

  // Hashing a value that JSON.stringify would quietly change (NaN to null, a Date to a string,
  // a Map to {}) would let two different requests share one hash, so all of them are refused.
  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a BigInt', 10n],
    ['a symbol', Symbol('s')],
    ['a function', () => 1],
    ['a Date', new Date(0)],
    ['a Map', new Map([[1, 2]])],
    ['a Set', new Set([1])],
    ['a class instance', new (class Thing {})()],
    ['an undefined array element', [1, undefined, 2]],
    // eslint-disable-next-line no-sparse-arrays
    ['a sparse array hole', [1, , 2]],
    ['a nested NaN', { a: { b: [Number.NaN] } }],
    ['a nested Date', { at: new Date(0) }],
    ['a symbol key', { [Symbol('k')]: 1 }],
  ])('refuses %s with a CanonicalJsonError', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  test('refuses a circular value instead of overflowing the stack', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(CanonicalJsonError);
  });

  test('a value shared by two members is not mistaken for a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"x":1},"b":[{"x":1}]}');
  });

  test('accepts objects with a null prototype', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2, a: 1 });
    expect(canonicalJson(bare)).toBe('{"a":1,"b":2}');
  });

  test('sha256Hex is lowercase hex of the UTF-8 bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
