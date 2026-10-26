import type { EmailConnectionTestResult } from '../../../../shared/api.js';
import { ProviderError, type AttachmentStream, type FolderSyncResult, type MailProvider, type RemoteMessage, type SendOutcome } from '../types.js';

/** The fictional sample mailbox: readable from the local cache, "sending" is recorded locally and delivers nothing. */
export class FixtureProvider implements MailProvider {
  readonly kind = 'fixture';
  readonly canRead = true;
  readonly canSend = true;
  statusDetail() {
    return 'Sample mailbox with fictional messages. Sending only records the message locally; nothing is delivered.';
  }
  async testConnection(): Promise<EmailConnectionTestResult> {
    const ok = { ok: true, code: null, message: null };
    return { ok: true, imap: ok, smtp: ok, sentFolder: null };
  }
  async syncFolder(): Promise<FolderSyncResult> {
    return { available: false, state: null, reset: false, messages: [], flags: [] };
  }
  async setSeen(): Promise<void> { /* local only */ }
  async searchFolder(): Promise<number[]> { return []; }
  async fetchMessages(): Promise<RemoteMessage[]> { return []; }
  async openAttachment(): Promise<AttachmentStream> {
    throw new ProviderError('not_found', 'The sample mailbox has no attachments.');
  }
  async send(): Promise<SendOutcome> {
    return { delivered: false, note: 'Sample mailbox: recorded locally, NOT delivered to anyone.', accepted: [], rejected: [], savedToSent: null };
  }
}
