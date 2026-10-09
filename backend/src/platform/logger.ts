import type { LoggerOptions } from 'pino';
import type { LogLevel } from './config.js';

// Anything that could hold a credential or key material is replaced before the line is written.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'refreshToken',
  'accessToken',
  'apiKey',
  'clientSecret',
  'privateKey',
  'jwtPrivateKeyPem',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
  '*.apiKey',
  '*.clientSecret',
  '*.privateKey',
  '*.jwtPrivateKeyPem',
];

export function loggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    base: { service: 'outpost-backend' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
}
