export const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...['arcade', 'arena', 'engine', 'feedback', 'gamepad', 'telemetry', 'identity', 'ranked-client', 'fullscreen', 'handles', 'records'].map(name => [`/${name}.mjs`, [`${name}.mjs`, 'text/javascript; charset=utf-8']]),
  ['/arcade.css', ['arcade.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/vendor/three.module.js', ['vendor/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.core.js', ['vendor/three.core.js', 'text/javascript; charset=utf-8']],
  ['/vendor/LICENSE.three.txt', ['vendor/LICENSE.three.txt', 'text/plain; charset=utf-8']],
  ['/vendor/webauthn-browser-14.0.0.mjs', ['vendor/webauthn-browser-14.0.0.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/LICENSE.webauthn.txt', ['vendor/LICENSE.webauthn.txt', 'text/plain; charset=utf-8']],
]);
