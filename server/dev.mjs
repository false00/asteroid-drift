import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildApp } from './server.mjs';
import { port } from './config.mjs';

const directory = new URL('../data/', import.meta.url);
const keyPath = new URL('master-key', directory);
const databasePath = fileURLToPath(new URL('game.sqlite', directory));
await mkdir(directory, { recursive: true, mode: 0o700 });
let masterKey;
try {
  masterKey = await readFile(keyPath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  try {
    await stat(databasePath);
    throw new Error('Existing database has no matching master key. Restore the key instead of replacing it.');
  } catch (missing) {
    if (missing.code !== 'ENOENT') throw missing;
  }
  masterKey = randomBytes(32);
  const handle = await open(keyPath, 'wx', 0o600);
  try { await handle.writeFile(masterKey); }
  finally { await handle.close(); }
}
const listenPort = port(process.env.DEV_PORT || '8080');
const { app } = await buildApp({
  origin: `http://localhost:${listenPort}`, rpID: 'localhost', listenAddress: '127.0.0.1',
  trustedProxy: null, allowHttpLocal: true, authEnabled: true, databasePath, masterKey,
});
process.once('SIGTERM', () => { void app.close(); });
process.once('SIGINT', () => { void app.close(); });
await app.listen({ host: '127.0.0.1', port: listenPort });
console.info(`Local development only: http://localhost:${listenPort}. State and a generated key remain in ignored data/. Production requires verified HTTPS.`);
