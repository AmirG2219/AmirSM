/** Sync engine: provider -> local cache. Provider-independent; tested with a fake provider and with the IMAP emulator. */
import type { Db, Row } from '../db/index.js';
import { parseJson, tx } from '../db/index.js';
import { applyFlags, recomputeThreads, removeVanished, deleteMessages, upsertRemote, type CacheAccount } from './cache.js';
import type { FolderRole, FolderSyncState, MailProvider } from './types.js';

export interface SyncJson { inbox?: FolderSyncState; sent?: FolderSyncState }
export const INITIAL_LIMIT: Record<FolderRole, number> = { inbox: 200, sent: 100 };
export const MAX_NEW_PER_RUN = 500;
const ROLES: FolderRole[] = ['inbox', 'sent'];

export interface SyncStats { added: number; removed: number; sentFolder: boolean }

export function readSyncState(db: Db, accountId: string): SyncJson {
  const r = db.prepare('SELECT sync_json FROM email_accounts WHERE id = ?').get(accountId) as Row | undefined;
  return parseJson<SyncJson>(r?.sync_json, {});
}

/** Push locally-made read/unread changes that the server has not confirmed yet. Returns the first error message, if any. */
export async function pushPendingSeen(db: Db, acc: CacheAccount, provider: MailProvider): Promise<string | null> {
  const state = readSyncState(db, acc.id);
  let error: string | null = null;
  for (const role of ROLES) {
    const folderName = state[role]?.folderName;
    if (!folderName) continue;
    for (const want of [1, 0]) {
      const rows = db.prepare('SELECT uid FROM email_messages WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND seen_pending = ?').all(acc.id, role, want) as Row[];
      if (!rows.length) continue;
      const uids = rows.map((r) => r.uid as number);
      try {
        for (let i = 0; i < uids.length; i += 200) await provider.setSeen(role, folderName, uids.slice(i, i + 200), !!want);
        db.prepare(`UPDATE email_messages SET seen_pending = NULL WHERE account_id = ? AND folder = ? AND seen_pending = ? AND uid IN (${uids.map(() => '?').join(',')})`).run(acc.id, role, want, ...uids);
      } catch (e) {
        error ??= (e as Error).message;
      }
    }
  }
  return error;
}

export async function syncAccount(db: Db, acc: CacheAccount, provider: MailProvider): Promise<SyncStats> {
  await pushPendingSeen(db, acc, provider);
  const stats: SyncStats = { added: 0, removed: 0, sentFolder: false };
  const state = readSyncState(db, acc.id);
  for (const role of ROLES) {
    const res = await provider.syncFolder({ role, state: state[role] ?? null, initialLimit: INITIAL_LIMIT[role], maxNew: MAX_NEW_PER_RUN });
    if (role === 'sent') stats.sentFolder = res.available;
    if (!res.available || !res.state) continue;
    const next = res.state;
    tx(db, () => {
      const touched = new Set<string>();
      if (res.reset) for (const t of deleteMessages(db, 'account_id = ? AND folder = ? AND uid IS NOT NULL', [acc.id, role])) touched.add(t);
      // oldest first, so parents exist before replies
      for (const m of [...res.messages].sort((a, b) => a.date.localeCompare(b.date) || a.uid - b.uid)) {
        const t = upsertRemote(db, acc, m);
        if (t) { touched.add(t); stats.added++; }
      }
      for (const t of applyFlags(db, acc, role, res.flags)) touched.add(t);
      const gone = removeVanished(db, acc, role, next.windowStartUid, next.uidNext, res.flags.map((f) => f.uid));
      stats.removed += gone.length;
      for (const t of gone) touched.add(t);
      recomputeThreads(db, touched);
    });
    state[role] = next;
  }
  db.prepare('UPDATE email_accounts SET sync_json = ? WHERE id = ?').run(JSON.stringify(state), acc.id);
  return stats;
}
