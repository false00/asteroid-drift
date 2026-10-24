import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isPublicHandle } from '../web/site/handles.mjs';

const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'moderator', 'curlred', 'curl_red', 'security', 'null', 'undefined']);

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function username(value) {
  if (!isPublicHandle(value)) throw new ApiError(400, 'invalid_username');
  const canonical = value.toLowerCase();
  if (RESERVED.has(canonical)) throw new ApiError(400, 'username_reserved');
  return { display: value, canonical };
}

export function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new ApiError(400, 'invalid_payload');
  }
  return value;
}

export function integer(value, low, high) {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new ApiError(400, 'invalid_number');
  return value;
}

export function base64url(value, maximum = 2048) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[^A-Za-z0-9_-]/.test(value)) throw new ApiError(400, 'invalid_encoding');
  return value;
}

export function webauthnCredential(value, registration) {
  object(value, ['id', 'rawId', 'response', 'type', 'clientExtensionResults', 'authenticatorAttachment'], ['id', 'rawId', 'response', 'type', 'clientExtensionResults']);
  base64url(value.id);
  if (value.rawId !== value.id || value.type !== 'public-key') throw new ApiError(400, 'invalid_credential');
  if (value.authenticatorAttachment != null && !['platform', 'cross-platform'].includes(value.authenticatorAttachment)) throw new ApiError(400, 'invalid_credential');
  if (!value.clientExtensionResults || typeof value.clientExtensionResults !== 'object' || Array.isArray(value.clientExtensionResults) || JSON.stringify(value.clientExtensionResults).length > 1024) throw new ApiError(400, 'invalid_credential');
  const required = registration ? ['clientDataJSON', 'attestationObject'] : ['clientDataJSON', 'authenticatorData', 'signature'];
  const allowed = registration ? [...required, 'transports', 'publicKeyAlgorithm', 'publicKey', 'authenticatorData'] : [...required, 'userHandle'];
  object(value.response, allowed, required);
  for (const key of required) base64url(value.response[key], key === 'attestationObject' ? 12288 : 4096);
  if (!registration && value.response.userHandle != null) base64url(value.response.userHandle, 128);
  if (registration && value.response.transports !== undefined) {
    if (!Array.isArray(value.response.transports) || value.response.transports.length > 8 || value.response.transports.some(item => !['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card'].includes(item))) throw new ApiError(400, 'invalid_credential');
  }
  if (registration) {
    for (const key of ['publicKey', 'authenticatorData']) if (value.response[key] !== undefined) base64url(value.response[key], 4096);
    if (value.response.publicKeyAlgorithm !== undefined) integer(value.response.publicKeyAlgorithm, -65536, 65536);
  }
  return value;
}

export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest();
export const equal = (left, right) => left.length === right.length && timingSafeEqual(left, right);
export const tokenMatches = (value, expected) => typeof value === 'string' && value.length <= 2048 && equal(digest(value), Buffer.from(expected));

export function cookieToken(header) {
  if (!header) return null;
  if (typeof header !== 'string' || header.length > 4096 || /[\x00-\x1f\x7f]/.test(header)) throw new ApiError(400, 'invalid_cookie');
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith('__Host-curlred_session='));
  if (values.length > 1) throw new ApiError(400, 'ambiguous_cookie');
  if (!values.length) return null;
  const value = values[0].slice('__Host-curlred_session='.length);
  if (value.length !== 43 || /[^A-Za-z0-9_-]/.test(value) || Buffer.from(value, 'base64url').length !== 32) throw new ApiError(400, 'invalid_cookie');
  return value;
}

export class Budget {
  constructor({ maximum = 5000, now = Date.now } = {}) {
    this.maximum = maximum;
    this.now = now;
    this.entries = new Map();
  }

  take(key, limit, windowMs) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (!entry && this.entries.size >= this.maximum) {
        for (const [name, candidate] of this.entries) if (candidate.until <= now) this.entries.delete(name);
        if (this.entries.size >= this.maximum) throw new ApiError(503, 'capacity_unavailable');
      }
      entry = { count: 0, until: now + windowMs };
      this.entries.set(key, entry);
    }
    if (++entry.count > limit) throw new ApiError(429, 'rate_limited');
  }
}
