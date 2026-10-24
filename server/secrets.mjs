import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export class Secrets {
  constructor(master) {
    if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('A private 32-byte master key is required.');
    const derive = purpose => Buffer.from(hkdfSync('sha256', master, 'curlred-ranked-v1', purpose, 32));
    this.encryption = derive('encrypted-storage');
    this.lookupKey = derive('username-lookup');
    this.csrfKey = derive('session-csrf');
    this.auditKey = derive('audit-chain');
  }

  lookup(value) {
    return createHmac('sha256', this.lookupKey).update(value).digest();
  }

  csrf(sessionHash) {
    return createHmac('sha256', this.csrfKey).update(sessionHash).digest('base64url');
  }

  seal(value, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryption, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  open(value, context) {
    const bytes = Buffer.from(value);
    if (bytes.length < 28) throw new Error('Encrypted storage is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.encryption, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }

  auditHash(previous, id, value) {
    return createHmac('sha256', this.auditKey).update(`${previous}|${id}|`).update(value).digest('hex');
  }
}
