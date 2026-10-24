import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../../web/site/vendor/', import.meta.url));
await build({
  entryPoints: [fileURLToPath(import.meta.resolve('@simplewebauthn/browser'))],
  outfile: `${output}webauthn-browser-14.0.0.mjs`,
  bundle: true, minify: true, format: 'esm', platform: 'browser', target: ['safari16', 'chrome110', 'firefox115'],
  legalComments: 'eof',
});
await copyFile(new URL('../../node_modules/@simplewebauthn/browser/LICENSE.md', import.meta.url), `${output}LICENSE.webauthn.txt`);
