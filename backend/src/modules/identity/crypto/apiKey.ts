// A service client's API key looks like opk_<clientId>.<secret>. The game server keeps it in the
// Roblox Secrets Store and sends it as "Authorization: ApiKey <key>" (a Roblox Secret can only be
// placed in headers, with a prefix, never in a JSON body). MySQL keeps only an Argon2id hash of the secret.
export interface ApiKey {
  clientId: string;
  secret: string;
}

// Both patterns are anchored with no nested repetition, so matching is linear in the input length.
// The length caps below also mean nothing long ever reaches them.
const API_KEY = /^opk_([a-z0-9-]{3,40})\.([A-Za-z0-9_-]{32,128})$/;
const HEADER = /^ApiKey (\S+)$/;
const MAX_KEY_LENGTH = 'opk_'.length + 40 + 1 + 128;
const MAX_HEADER_LENGTH = 'ApiKey '.length + MAX_KEY_LENGTH;

export function parseApiKey(value: string): ApiKey | null {
  if (typeof value !== 'string' || value.length > MAX_KEY_LENGTH) return null;
  const match = API_KEY.exec(value);
  return match?.[1] && match[2] ? { clientId: match[1], secret: match[2] } : null;
}

// Strict on purpose, like bearerToken: exactly "ApiKey <key>", one space, nothing after.
export function parseApiKeyHeader(header: string | undefined): ApiKey | null {
  if (typeof header !== 'string' || header.length > MAX_HEADER_LENGTH) return null;
  const match = HEADER.exec(header);
  return match?.[1] ? parseApiKey(match[1]) : null;
}
