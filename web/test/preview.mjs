import { randomBytes } from 'node:crypto';
import { buildApp } from '../../server/server.mjs';

const { app } = await buildApp({
  test: true, origin: 'http://127.0.0.1:4178', rpID: '127.0.0.1', listenAddress: '127.0.0.1',
  trustedProxy: null, databasePath: ':memory:', masterKey: randomBytes(32),
});
process.once('SIGTERM', () => { void app.close(); });
process.once('SIGINT', () => { void app.close(); });
await app.listen({ host: '127.0.0.1', port: 4178 });
console.info('Isolated browser-test server: http://127.0.0.1:4178');
