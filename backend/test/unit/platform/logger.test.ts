import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { loggerOptions } from '../../../src/platform/logger.js';

function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('logger redaction', () => {
  test('tokens, passwords, keys and API keys never reach the log', () => {
    const out = capture();
    const log = pino(loggerOptions('info'), out.stream);
    log.info(
      {
        req: {
          headers: {
            authorization: 'Bearer secret-jwt',
            cookie: 'sid=secret-cookie',
            'x-api-key': 'secret-header-key',
          },
        },
        res: { headers: { 'set-cookie': 'sid=secret-set-cookie' } },
        password: 'hunter2',
        refreshToken: 'secret-top-refresh',
        privateKey: 'secret-private-pem',
        jwtPrivateKeyPem: 'secret-config-pem',
        body: { refreshToken: 'secret-refresh', apiKey: 'opk_game-server.secret-key', password: 'secret-nested-pw' },
        config: { privateKey: 'secret-nested-pem', jwtPrivateKeyPem: 'secret-nested-config-pem' },
      },
      'login attempt',
    );
    const text = out.text();
    const secrets = [
      'secret-jwt',
      'secret-cookie',
      'secret-header-key',
      'secret-set-cookie',
      'hunter2',
      'secret-top-refresh',
      'secret-private-pem',
      'secret-config-pem',
      'secret-refresh',
      'secret-key',
      'secret-nested-pw',
      'secret-nested-pem',
      'secret-nested-config-pem',
    ];
    for (const secret of secrets) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('[redacted]');
    expect(text).toContain('login attempt');
  });

  test('ordinary fields still get logged', () => {
    const out = capture();
    pino(loggerOptions('info'), out.stream).info({ userId: 'u-42' }, 'hello');
    expect(out.text()).toContain('u-42');
  });
});
