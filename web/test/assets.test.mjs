import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { FILES } from '../../server/assets.mjs';

const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');

test('the explicit static allowlist contains real browser files, not server code or state', async () => {
  for (const [path, [name]] of FILES) {
    assert.ok(path.startsWith('/'));
    assert.ok(!name.includes('..'));
    assert.ok((await stat(new URL(`../site/${name}`, import.meta.url))).isFile());
  }
  for (const path of ['/server.mjs', '/config.mjs', '/.env', '/master-key', '/game.sqlite', '/package.json']) assert.ok(!FILES.has(path));
});

test('all browser dependencies are self-hosted and HTML has no inline executable code', async () => {
  assert.doesNotMatch(html, /<style\b|style=|on(?:click|load|error)=|https?:\/\//i);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.match(html, /<script type="module" src="\/arcade\.mjs\?v=20261024\.7"><\/script>/);
  for (const [path, [name]] of FILES) {
    if (!name.endsWith('.mjs') || name.startsWith('vendor/')) continue;
    const source = await readFile(new URL(`../site/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\beval\s*\(|new Function/);
    for (const [, dependency] of source.matchAll(/^import .+ from '([^']+)';$/gm)) assert.ok(FILES.has(new URL(dependency, `https://arcade.example${path}`).pathname));
  }
});

test('mobile viewport retains accessible zoom metadata, stable sizing, and safe areas', async () => {
  const css = await readFile(new URL('../site/arcade.css', import.meta.url), 'utf8');
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
  for (const feature of ['safe-area-inset-bottom', '100svh', 'container: arcade / size', 'prefers-reduced-motion']) assert.ok(css.includes(feature));
  assert.doesNotMatch(css, /100dvh/);
});
