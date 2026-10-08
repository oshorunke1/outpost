import { isIP } from 'node:net';
import { z } from 'zod';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

// false (the default) trusts no proxy: request.ip is the socket peer and X-Forwarded-For is ignored.
// A list trusts X-Forwarded-For only when the socket peer is one of those proxy addresses or ranges.
// Hop counts and true are refused on purpose. With either one, a client that reaches the app port
// directly (not through the proxy) can send its own X-Forwarded-For, pick any IP it likes and get a
// fresh rate limit bucket on every request. Fastify 5 treats a number as "trust nothing" for the same
// reason. Behind a load balancer, set TRUST_PROXY to the load balancer's CIDR.
export type TrustProxy = false | string[];

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
  trustProxy: TrustProxy;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const port = z.coerce.number().int().min(1).max(65535);
const TRUST_PROXY_HINT =
  "TRUST_PROXY must be false or a comma separated list of the proxy's IPs or CIDR ranges (hop counts and true are refused, set the proxy CIDR instead)";

function isAddressOrCidr(entry: string): boolean {
  const [address = '', prefix, extra] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

function parseTrustProxy(raw: string): TrustProxy | null {
  const value = raw.trim();
  if (value === '' || value === 'false') return false;
  const entries = value.split(',').map((entry) => entry.trim());
  return entries.every(isAddressOrCidr) ? entries : null;
}

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
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((raw, context) => {
      const parsed = parseTrustProxy(raw);
      if (parsed === null) {
        context.addIssue({ code: 'custom', message: TRUST_PROXY_HINT });
        return z.NEVER;
      }
      return parsed;
    }),
});

// Reads the environment once at startup. Errors name the variables but never their values,
// because values such as DATABASE_URL carry passwords.
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    // The hint is a fixed sentence, so it never echoes the value that was set.
    const hint = names.includes('TRUST_PROXY') ? `. ${TRUST_PROXY_HINT}` : '';
    throw new ConfigError(`invalid or missing environment variables: ${names.join(', ')}${hint}`);
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
    trustProxy: e.TRUST_PROXY,
  };
}
