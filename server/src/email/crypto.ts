/**
 * Encryption of mailbox credentials at rest: AES-256-GCM with a random 256-bit key kept in a key file
 * (DATA_DIR/secret.key by default), never in the database.
 *
 * What this protects: a leaked/copied database file (backup, support bundle, cloud sync of the .db alone).
 * What it does NOT protect: someone who can read the whole data directory / disk (the key sits next to the DB),
 * or malware running as the owner. It is not a substitute for OS disk encryption. See docs/EMAIL.md.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 'v1';
const KEY_BYTES = 32;

export class SecretBoxError extends Error {
  constructor(public code: 'bad_key_file' | 'cannot_decrypt' | 'bad_format', message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export class SecretBox {
  private constructor(private key: Buffer) {
    if (key.length !== KEY_BYTES) throw new SecretBoxError('bad_key_file', 'Encryption key must be 32 bytes.');
  }

  static fromKey(key: Buffer): SecretBox {
    return new SecretBox(Buffer.from(key));
  }

  /**
   * Loads the key file, creating it (random key, owner-only permissions where the OS supports them) on first use.
   * A corrupt key file is an error — it is never silently replaced, because that would make stored credentials unreadable
   * without telling the owner.
   */
  static fromFile(file: string): SecretBox {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const key = /^[A-Za-z0-9_-]{43}=?$/.test(raw) ? Buffer.from(raw, 'base64url') : Buffer.alloc(0);
      if (key.length !== KEY_BYTES) throw new SecretBoxError('bad_key_file', `The encryption key file is damaged (${path.basename(file)}). Move it away and reconnect your mailbox.`);
      return new SecretBox(key);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const key = crypto.randomBytes(KEY_BYTES);
    try {
      // 'wx': never overwrite a key that appeared in the meantime. mode 0600 is honoured on POSIX; Windows uses the folder ACL.
      fs.writeFileSync(file, key.toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return SecretBox.fromFile(file);
      throw e;
    }
    return new SecretBox(key);
  }

  /** `aad` binds the ciphertext to its owner (the account id) so a blob cannot be moved to another row. */
  encrypt(plain: string, aad: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(blob: string, aad: string): string {
    const parts = blob.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError('bad_format', 'Stored credentials are in an unknown format.');
    try {
      const iv = Buffer.from(parts[1]!, 'base64url');
      const tag = Buffer.from(parts[2]!, 'base64url');
      const ct = Buffer.from(parts[3]!, 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('bad lengths');
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch {
      throw new SecretBoxError('cannot_decrypt', 'Stored credentials cannot be decrypted (the key file is missing or was replaced, or the data was altered). Reconnect the mailbox.');
    }
  }
}
