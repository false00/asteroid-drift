import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

export function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  let count = 0;
  let userHandle;
  const hash = value => createHash('sha256').update(value).digest();
  const b64 = value => Buffer.from(value).toString('base64url');
  return {
    id: b64(credentialId),
    register(options, { origin = 'https://arcade.example', rpID = 'arcade.example', uv = true } = {}) {
      userHandle = options.user.id;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const key = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
      const authData = Buffer.concat([hash(rpID), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16), length, credentialId, key]);
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
      return {
        id: b64(credentialId), rawId: b64(credentialId), type: 'public-key',
        authenticatorAttachment: 'platform', clientExtensionResults: { credProps: { rk: true } },
        response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
      };
    },
    login(options, { origin = 'https://arcade.example', rpID = 'arcade.example', uv = true, counter, handle = userHandle } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(counter ?? ++count);
      const authenticatorData = Buffer.concat([hash(rpID), Buffer.from([uv ? 5 : 1]), buffer]);
      const signature = sign('sha256', Buffer.concat([authenticatorData, hash(clientDataJSON)]), pair.privateKey);
      return {
        id: b64(credentialId), rawId: b64(credentialId), type: 'public-key',
        authenticatorAttachment: 'platform', clientExtensionResults: {},
        response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle: handle },
      };
    },
  };
}
