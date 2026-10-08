import { z } from 'zod';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  metricsPort: number;
  databaseUrl: string;
  redisUrl: string;
  jwtIssuer: string;
  jwtPrivateKeyPem: string | null;
  logLevel: LogLevel;
  trustProxy: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const port = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: port.default(3000),
  METRICS_PORT: port.default(9464),
  DATABASE_URL: z.string().startsWith('mysql://'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),
  JWT_ISSUER: z.string().min(1).default('outpost'),
  JWT_PRIVATE_KEY_PEM: z.string().includes('BEGIN PRIVATE KEY').optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

// Reads the environment once at startup. Errors name the variables but never their values,
// because values such as DATABASE_URL carry passwords.
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new ConfigError(`invalid or missing environment variables: ${names.join(', ')}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && !e.JWT_PRIVATE_KEY_PEM) {
    throw new ConfigError('JWT_PRIVATE_KEY_PEM is required in production');
  }
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    metricsPort: e.METRICS_PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtIssuer: e.JWT_ISSUER,
    jwtPrivateKeyPem: e.JWT_PRIVATE_KEY_PEM ?? null,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY === 'true',
  };
}
