import Database from 'better-sqlite3';

const [operation, afterText, limitText] = process.argv.slice(2);
const after = Number(afterText);
const limit = Number(limitText || 64);
const digits = value => typeof value === 'string' && value.length >= 1 && value.length <= 16 && !/[^0-9]/.test(value);
if (!['export', 'ack'].includes(operation) || !digits(afterText) || (limitText !== undefined && !digits(limitText)) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
  console.error('Expected export <after> [limit<=64] or ack <through>.');
  process.exitCode = 1;
} else if (!process.env.DATABASE_PATH) {
  console.error('DATABASE_PATH must explicitly identify the existing application database.');
  process.exitCode = 1;
} else {
  const db = new Database(process.env.DATABASE_PATH, { readonly: operation === 'export', fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, row.value]));
    const latest = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq || 0);
    if (operation === 'export') {
      const rows = db.prepare('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit);
      const result = {
        instance_id: metadata.instance_id, latest_sequence: latest, acknowledged: Number(metadata.acked || 0),
        events: rows.map(row => ({
          sequence: row.sequence, id: row.id, kind: row.kind, cipher: Buffer.from(row.cipher).toString('base64'),
          previous_hash: row.previous_hash, hash: row.hash,
        })),
      };
      const encoded = JSON.stringify(result);
      if (Buffer.byteLength(encoded) > 1500000) throw new Error('Export exceeds the fixed output budget.');
      process.stdout.write(encoded);
    } else {
      if (after < Number(metadata.acked || 0) || after > latest) throw new Error('Acknowledgement is outside the durable event range.');
      db.transaction(() => {
        db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('acked',?)").run(String(after));
        db.prepare('DELETE FROM events WHERE sequence<=? AND created_at<?').run(after, Date.now() - 7 * 86400000);
      }).immediate();
      process.stdout.write(JSON.stringify({ acknowledged: after }));
    }
  } catch {
    console.error('The fixed audit export/ack operation failed. No credential or event payload was logged.');
    process.exitCode = 1;
  } finally { db.close(); }
}
