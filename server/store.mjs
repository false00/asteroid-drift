import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, base64url, digest, integer, token, username } from './validation.mjs';
import { Secrets } from './secrets.mjs';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const CHALLENGE_MS = 2 * 60 * 1000;

export class Store {
  constructor({ path, masterKey, now = Date.now }) {
    this.now = now;
    this.secrets = new Secrets(masterKey);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('trusted_schema = OFF');
    this.db.pragma('secure_delete = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('max_page_count = 65536');
    this.db.pragma('journal_size_limit = 16777216');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        handle_lookup BLOB NOT NULL UNIQUE CHECK(length(handle_lookup)=32),
        handle_cipher BLOB NOT NULL CHECK(length(handle_cipher) BETWEEN 31 AND 80),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 2048),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL CHECK(length(public_key) BETWEEN 32 AND 4096),
        counter INTEGER NOT NULL CHECK(counter>=0),
        transports TEXT NOT NULL CHECK(length(transports)<=256),
        device_type TEXT NOT NULL CHECK(length(device_type)<=32),
        backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        hash BLOB PRIMARY KEY CHECK(length(hash)=32),
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        seen_at INTEGER NOT NULL,
        verified_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS challenges (
        session_hash BLOB PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('register','login','add_key','delete_account')),
        challenge_hash BLOB NOT NULL CHECK(length(challenge_hash)=32),
        context_cipher BLOB NOT NULL CHECK(length(context_cipher)<=4096),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS leaderboard (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE,
        score INTEGER NOT NULL CHECK(score>0 AND score<=9007199254740991),
        wave INTEGER NOT NULL CHECK(wave>0),
        duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
        achievement_order INTEGER NOT NULL UNIQUE,
        finished_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
        state_cipher BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('audit','gameplay')),
        created_at INTEGER NOT NULL,
        cipher BLOB NOT NULL CHECK(length(cipher)<=16384),
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS tombstones (handle_lookup BLOB PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
    `);
    this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('audit_hash',?)").run('0'.repeat(64));
    this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES ('instance_id',?)").run(randomUUID());
    this.instanceId = this.db.prepare("SELECT value FROM metadata WHERE key='instance_id'").get().value;
    const check = this.db.prepare("SELECT value FROM metadata WHERE key='key_check'").get();
    const context = `key-check:${this.instanceId}`;
    if (check) {
      if (this.secrets.open(Buffer.from(check.value, 'base64'), context) !== 'curlred-ranked-store-v1') throw new Error('The database master key is invalid.');
    } else {
      this.db.prepare("INSERT INTO metadata(key,value) VALUES ('key_check',?)").run(this.secrets.seal('curlred-ranked-store-v1', context).toString('base64'));
    }
  }

  close() { this.db.close(); }
  atomic(operation) { return this.db.transaction(operation).immediate(); }

  account(id) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (!row) return null;
    const handle = this.secrets.open(row.handle_cipher, `account:${row.id}`);
    username(handle);
    return { id: row.id, username: handle, createdAt: row.created_at };
  }

  available(handle) {
    const { canonical } = username(handle);
    const lookup = this.secrets.lookup(canonical);
    return !this.db.prepare('SELECT 1 FROM accounts WHERE handle_lookup=?').get(lookup)
      && !this.db.prepare('SELECT 1 FROM tombstones WHERE handle_lookup=? AND expires_at>?').get(lookup, this.now());
  }

  createSession(accountId = null) {
    const value = token();
    const hash = digest(value);
    const now = this.now();
    const expires = now + (accountId ? SESSION_MAX_MS : 5 * 60 * 1000);
    this.db.prepare('INSERT INTO sessions(hash,account_id,created_at,seen_at,verified_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(hash, accountId, now, now, accountId ? now : 0, expires);
    return { value, hash, accountId, csrf: this.secrets.csrf(hash), createdAt: now, verifiedAt: accountId ? now : 0, expiresAt: expires };
  }

  session(value) {
    if (!value) return null;
    const hash = digest(value);
    const row = this.db.prepare('SELECT * FROM sessions WHERE hash=?').get(hash);
    if (!row || row.expires_at <= this.now() || (row.account_id && row.seen_at + SESSION_IDLE_MS <= this.now())) return null;
    const account = row.account_id ? this.account(row.account_id) : null;
    if (row.account_id && !account) return null;
    return { hash, accountId: row.account_id, account, csrf: this.secrets.csrf(hash), createdAt: row.created_at, verifiedAt: row.verified_at, expiresAt: row.expires_at };
  }

  touchSession(hash) {
    this.db.prepare('UPDATE sessions SET seen_at=? WHERE hash=?').run(this.now(), hash);
  }

  dropSession(hash) {
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);
  }

  challenge(session, purpose, challenge, context = {}) {
    const now = this.now();
    this.db.prepare('DELETE FROM challenges WHERE expires_at<=?').run(now);
    if (this.db.prepare('SELECT count(*) AS n FROM challenges').get().n >= 256) throw new ApiError(503, 'capacity_unavailable');
    this.db.prepare('INSERT OR REPLACE INTO challenges(session_hash,purpose,challenge_hash,context_cipher,expires_at) VALUES (?,?,?,?,?)')
      .run(session.hash, purpose, digest(challenge), this.secrets.seal(JSON.stringify(context), `challenge:${session.hash.toString('hex')}`), now + CHALLENGE_MS);
  }

  consumeChallenge(session, purpose) {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM challenges WHERE session_hash=?').get(session.hash);
      this.db.prepare('DELETE FROM challenges WHERE session_hash=?').run(session.hash);
      if (!row || row.purpose !== purpose || row.expires_at <= this.now()) throw new ApiError(400, 'challenge_expired');
      return { hash: row.challenge_hash, context: JSON.parse(this.secrets.open(row.context_cipher, `challenge:${session.hash.toString('hex')}`)) };
    });
  }

  audit(action, actor, ip, details = {}, kind = 'audit') {
    return this.atomic(() => this.appendEvent(action, actor, ip, details, kind));
  }

  appendEvent(action, actor, ip, details, kind) {
    if (!/^[a-z][a-z0-9_.]{2,63}$/.test(action)) throw new Error('Invalid audit action.');
    if (actor?.username) username(actor.username);
    const id = randomUUID();
    const created = this.now();
    const event = kind === 'audit' ? {
      '@timestamp': new Date(created).toISOString(),
      event_dataset: 'curlred.audit',
      event_action: action,
      actor: actor ? { account_id: actor.id, username: actor.username } : null,
      client_ip: ip || null,
      details,
    } : details;
    const encoded = JSON.stringify(event);
    if (Buffer.byteLength(encoded) > 12000) throw new Error('Audit event exceeds its storage budget.');
    const previous = this.db.prepare("SELECT value FROM metadata WHERE key='audit_hash'").get().value;
    const hash = this.secrets.auditHash(previous, id, encoded);
    const inserted = this.db.prepare('INSERT INTO events(id,kind,created_at,cipher,previous_hash,hash) VALUES (?,?,?,?,?,?)')
      .run(id, kind, created, this.secrets.seal(encoded, `event:${id}:${kind}`), previous, hash);
    this.db.prepare("UPDATE metadata SET value=? WHERE key='audit_hash'").run(hash);
    return Number(inserted.lastInsertRowid);
  }

  register({ id, handle, credential, deviceType, backedUp, ip }) {
    return this.atomic(() => {
      const checked = username(handle);
      if (!this.available(handle)) throw new ApiError(409, 'username_unavailable');
      if (this.db.prepare('SELECT count(*) AS n FROM accounts').get().n >= 10000) throw new ApiError(503, 'capacity_unavailable');
      this.db.prepare('INSERT INTO accounts(id,handle_lookup,handle_cipher,created_at) VALUES (?,?,?,?)')
        .run(id, this.secrets.lookup(checked.canonical), this.secrets.seal(checked.display, `account:${id}`), this.now());
      this.addCredential(id, credential, deviceType, backedUp);
      const account = this.account(id);
      this.audit('account.created', account, ip, { user_verification: true });
      return account;
    });
  }

  addCredential(accountId, credential, deviceType, backedUp) {
    base64url(credential.id);
    integer(credential.counter, 0, 4294967295);
    if (credential.publicKey.byteLength < 32 || credential.publicKey.byteLength > 4096 || !['singleDevice', 'multiDevice'].includes(deviceType)) throw new ApiError(400, 'invalid_credential');
    if (this.db.prepare('SELECT 1 FROM credentials WHERE id=?').get(credential.id)) throw new ApiError(409, 'passkey_already_registered');
    if (this.db.prepare('SELECT count(*) AS n FROM credentials WHERE account_id=?').get(accountId).n >= 5) throw new ApiError(409, 'passkey_limit');
    this.db.prepare('INSERT INTO credentials(id,account_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(credential.id, accountId, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), deviceType, Number(backedUp), this.now());
  }

  credential(id) {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id);
    if (!row) return null;
    return { id: row.id, accountId: row.account_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) };
  }

  credentials(accountId) {
    return this.db.prepare('SELECT id,transports,device_type,backed_up,created_at FROM credentials WHERE account_id=? ORDER BY created_at')
      .all(accountId).map(row => ({ id: row.id, transports: JSON.parse(row.transports), deviceType: row.device_type, backedUp: Boolean(row.backed_up), createdAt: row.created_at }));
  }

  leaderboard() {
    return this.db.prepare('SELECT * FROM leaderboard ORDER BY score DESC,achievement_order ASC LIMIT 10').all()
      .map((row, i) => ({
        rank: i + 1, username: this.account(row.account_id).username,
        score: row.score, wave: row.wave, durationMs: row.duration_ms, finishedAt: row.finished_at,
      }));
  }

  finalize(run, reason) {
    return this.atomic(() => {
      const pending = this.db.prepare('SELECT account_id FROM runs WHERE id=?').get(run.id);
      if (!pending || pending.account_id !== run.accountId) throw new ApiError(409, 'run_not_active');
      const account = this.account(run.accountId);
      if (!account) throw new ApiError(401, 'authentication_required');
      const score = run.game.score;
      const duration = Math.floor(run.game.elapsed * 1000);
      if (!Number.isSafeInteger(score) || score < 0) throw new Error('Authoritative score is invalid.');
      const order = this.audit('ranked.finished', account, run.ip, {
        ...run.summary(), reason, rules: 'ranked-v1',
      });
      if (score > 0 && run.activeMs >= 2000) {
        this.db.prepare(`INSERT INTO leaderboard(account_id,run_id,score,wave,duration_ms,achievement_order,finished_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
          run_id=excluded.run_id,score=excluded.score,wave=excluded.wave,duration_ms=excluded.duration_ms,
          achievement_order=excluded.achievement_order,finished_at=excluded.finished_at WHERE excluded.score>leaderboard.score`)
          .run(account.id, run.id, score, run.game.wave, duration, order, this.now());
        this.db.prepare('DELETE FROM leaderboard WHERE account_id NOT IN (SELECT account_id FROM leaderboard ORDER BY score DESC,achievement_order ASC LIMIT 10)').run();
      }
      this.db.prepare('DELETE FROM runs WHERE id=?').run(run.id);
      const position = this.db.prepare('SELECT account_id FROM leaderboard ORDER BY score DESC,achievement_order ASC LIMIT 10').all().findIndex(row => row.account_id === account.id);
      this.audit('leaderboard.evaluated', account, run.ip, { run_id: run.id, retained: position >= 0, rank: position >= 0 ? position + 1 : null });
      return { score, wave: run.game.wave, durationMs: duration, rank: position >= 0 ? position + 1 : null };
    });
  }

  checkpoint(run) {
    this.db.prepare('INSERT INTO runs(id,account_id,state_cipher,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_cipher=excluded.state_cipher,updated_at=excluded.updated_at')
      .run(run.id, run.accountId, this.secrets.seal(JSON.stringify(run.checkpoint()), `run:${run.id}`), this.now());
  }

  recover() {
    return this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT 32').all()
      .map(row => ({ id: row.id, accountId: row.account_id, updatedAt: row.updated_at, state: JSON.parse(this.secrets.open(row.state_cipher, `run:${row.id}`)) }));
  }

  export(after, limit) {
    return this.db.prepare('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit).map(row => ({
      sequence: row.sequence, id: row.id, kind: row.kind, instance_id: this.instanceId,
      previous_hash: row.previous_hash, hash: row.hash,
      payload: JSON.parse(this.secrets.open(row.cipher, `event:${row.id}:${row.kind}`)),
    }));
  }

  acknowledge(through) {
    this.atomic(() => {
      const old = Number(this.db.prepare("SELECT value FROM metadata WHERE key='acked'").get()?.value || 0);
      if (through < old) throw new Error('Audit acknowledgement cannot move backward.');
      this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('acked',?)").run(String(through));
      this.db.prepare('DELETE FROM events WHERE sequence<=? AND created_at<?').run(through, this.now() - 7 * 86400000);
    });
  }

  cleanup() {
    const now = this.now();
    this.atomic(() => {
      const expired = this.db.prepare('SELECT * FROM sessions WHERE expires_at<=? OR (account_id IS NOT NULL AND seen_at<=?)').all(now, now - SESSION_IDLE_MS);
      for (const row of expired) if (row.account_id) this.audit('session.expired', this.account(row.account_id), null, { reason: row.expires_at <= now ? 'absolute' : 'idle' });
      this.db.prepare('DELETE FROM sessions WHERE expires_at<=? OR (account_id IS NOT NULL AND seen_at<=?)').run(now, now - SESSION_IDLE_MS);
      this.db.prepare('DELETE FROM challenges WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM tombstones WHERE expires_at<=?').run(now);
    });
  }
}
