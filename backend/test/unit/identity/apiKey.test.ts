import { describe, expect, test } from 'vitest';
import { parseApiKey, parseApiKeyHeader } from '../../../src/modules/identity/crypto/apiKey.js';

const secret = 'A'.repeat(43);
const KEY = `opk_game-server.${secret}`;

describe('API keys', () => {
  test('parse into client id and secret', () => {
    expect(parseApiKey(KEY)).toEqual({ clientId: 'game-server', secret });
    expect(parseApiKeyHeader(`ApiKey ${KEY}`)).toEqual({ clientId: 'game-server', secret });
    // The edges of both lengths still parse.
    expect(parseApiKey(`opk_abc.${'b'.repeat(32)}`)).toEqual({ clientId: 'abc', secret: 'b'.repeat(32) });
    expect(parseApiKey(`opk_${'a'.repeat(40)}.${'_'.repeat(128)}`)).toEqual({ clientId: 'a'.repeat(40), secret: '_'.repeat(128) });
  });

  test('hostile or malformed keys are null and never throw', () => {
    const hostile = [
      '',
      ' ',
      'opk_',
      'opk_.',
      `opk_.${secret}`,
      `opk_Game.${secret}`,
      `opk_ga.${secret}`,
      `opk_${'a'.repeat(41)}.${secret}`,
      'opk_game-server.short',
      `opk_game-server.${'A'.repeat(31)}`,
      `opk_game-server.${'A'.repeat(129)}`,
      `pk_game-server.${secret}`,
      `OPK_game-server.${secret}`,
      `${KEY} `,
      ` ${KEY}`,
      `${KEY}\n`,
      `${KEY}\r\n`,
      `\n${KEY}`,
      `${KEY}\u0000`,
      `opk_game_server.${secret}`,
      `opk_game-server..${secret}`,
      `${KEY}.${secret}`,
      `${KEY}=`,
      `${KEY}+`,
      `${KEY}/`,
      `opk_g${'ａ'}me.${secret}`, // fullwidth a
      `opk_game${'​'}.${secret}`, // zero width space
      `opk_${'ğ'}ame.${secret}`,
      `opk_game-server.${'A'.repeat(42)}${'Å'}`,
      `opk_game-server:${secret}`,
      `opk_game-server%2E${secret}`,
      `opk_${'a-'.repeat(100_000)}.${secret}`,
      `opk_game-server.${'A'.repeat(1_000_000)}`,
      'opk_'.repeat(50_000),
    ];
    for (const bad of hostile) expect(parseApiKey(bad)).toBeNull();
    for (const notString of [undefined, null, 42, {}, [KEY], { toString: () => KEY }]) {
      expect(parseApiKey(notString as unknown as string)).toBeNull();
    }
  });

  test('hostile or malformed headers are null', () => {
    const hostile = [
      undefined,
      '',
      'ApiKey',
      'ApiKey ',
      'ApiKey nope',
      `ApiKey  ${KEY}`,
      `apikey ${KEY}`,
      `APIKEY ${KEY}`,
      `ApiKey\t${KEY}`,
      ` ApiKey ${KEY}`,
      `ApiKey ${KEY} `,
      `ApiKey ${KEY}\n`,
      `ApiKey ${KEY} extra`,
      `ApiKey ${KEY},ApiKey ${KEY}`,
      `ApiKey ${KEY}, ApiKey ${KEY}`,
      `Bearer ${KEY}`,
      `Basic ${Buffer.from(`game-server:${secret}`).toString('base64')}`,
      `ApiKey ${KEY}${'A'.repeat(1_000_000)}`,
      `ApiKey ${'ApiKey '.repeat(10_000)}${KEY}`,
    ];
    for (const bad of hostile) expect(parseApiKeyHeader(bad)).toBeNull();
    expect(parseApiKeyHeader([`ApiKey ${KEY}`] as unknown as string)).toBeNull();
  });

  test('a huge hostile input is rejected quickly', () => {
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      parseApiKey(`opk_${'a-'.repeat(100_000)}!`);
      parseApiKeyHeader(`ApiKey opk_${'a'.repeat(1_000_000)}`);
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
