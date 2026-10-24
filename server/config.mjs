import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export function port(value = '8443') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 5 || /[^0-9]/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return Number(value);
}

export function loadConfig(env = process.env, read = readFileSync) {
  if (!env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN is required.');
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || env.PUBLIC_ORIGIN !== origin.origin) throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin without a trailing slash.');
  const listenAddress = env.BIND_HOST || '127.0.0.1';
  if (!isIP(listenAddress)) throw new Error('BIND_HOST must be an IP address.');
  const trustedProxy = env.TRUSTED_PROXY_IP || null;
  if (trustedProxy && !isIP(trustedProxy)) throw new Error('TRUSTED_PROXY_IP must be one explicit IP address.');
  const clientIpHeader = env.CLIENT_IP_HEADER || 'x-forwarded-for';
  if (!['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'].includes(clientIpHeader)) throw new Error('CLIENT_IP_HEADER is not supported.');
  const redirectHost = env.REDIRECT_HOST || null;
  if (redirectHost) {
    const alias = new URL(`https://${redirectHost}`);
    if (alias.host !== redirectHost || alias.host === origin.host || alias.username || alias.password || alias.pathname !== '/' || alias.search || alias.hash) throw new Error('REDIRECT_HOST must be a distinct hostname with an optional port.');
  }
  if (!['0', '1'].includes(env.AUTH_ENABLED || '0')) throw new Error('AUTH_ENABLED must be 0 or 1.');
  if (!env.DATABASE_PATH) throw new Error('DATABASE_PATH is required.');
  const credential = (variable, name) => {
    const path = env[variable] || (env.CREDENTIALS_DIRECTORY && join(env.CREDENTIALS_DIRECTORY, name));
    if (!path) throw new Error(`${variable} or CREDENTIALS_DIRECTORY is required.`);
    return read(path);
  };
  const masterKey = credential('MASTER_KEY_FILE', 'master-key');
  if (masterKey.length !== 32) throw new Error('The master key must contain exactly 32 bytes.');
  return {
    origin: origin.origin, rpID: origin.hostname, listenAddress, port: port(env.PORT),
    trustedProxy, clientIpHeader, redirectHost, authEnabled: env.AUTH_ENABLED === '1',
    databasePath: env.DATABASE_PATH, masterKey,
    https: { key: credential('TLS_KEY_FILE', 'tls-key'), cert: credential('TLS_CERT_FILE', 'tls-cert'), minVersion: 'TLSv1.3' },
  };
}
