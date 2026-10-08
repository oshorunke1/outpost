import { describe, expect, test } from 'vitest';
import { LruCache } from '../../../src/modules/identity/crypto/lru.js';

describe('LruCache', () => {
  test('evicts the least recently used entry when full', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.has('a')).toBe(false);
    expect(cache.keys()).toEqual(['c', 'b']);
  });

  test('a get makes an entry the most recent', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.keys()).toEqual(['c', 'a']);
    expect(cache.get('b')).toBeUndefined();
  });

  test('setting an existing key updates it without growing', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(10);
    expect(cache.keys()).toEqual(['a', 'b']);
  });

  test('delete removes head, tail and middle entries', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.delete('b')).toBe(true);
    expect(cache.keys()).toEqual(['c', 'a']);
    expect(cache.delete('c')).toBe(true);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.size).toBe(0);
    cache.set('d', 4);
    expect(cache.keys()).toEqual(['d']);
  });

  test('a capacity below 1 or a fraction is refused', () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });
});
