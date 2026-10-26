/**
 * Raw RFC 822 -> RemoteMessage. Pure (no network): everything that comes out is plain text and bounded in size.
 * Bodies: text/plain when present, otherwise HTML converted to text by our own sanitising converter.
 */
import { simpleParser, type AddressObject } from 'mailparser';
import type { FolderRole, RemoteAttachment, RemoteMessage } from './types.js';
import { htmlToText, tidy } from './html-to-text.js';
import { cleanLine, cleanText, safeFilename } from './sanitize.js';

export const MAX_BODY_CHARS = 100_000;
const MAX_ADDRS = 50;
const MAX_REFS = 30;

export const normalizeMessageId = (id: string | null | undefined): string | null => {
  if (!id) return null;
  const m = /<([^<>\s]{1,500})>/.exec(id) ?? /^\s*([^<>\s]{1,500})\s*$/.exec(id);
  return m ? m[1]!.toLowerCase() : null;
};

function addrList(a: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  const out: string[] = [];
  for (const o of list) for (const v of o.value) if (v.address && out.length < MAX_ADDRS) out.push(cleanLine(v.address, 320).toLowerCase());
  return out;
}

export interface ParseMeta { folder: FolderRole; uid: number; seen: boolean; size?: number | null; serverThreadId?: string | null; attachments?: RemoteAttachment[]; sourceTruncated?: boolean }

export async function parseRawMessage(raw: Buffer, meta: ParseMeta): Promise<RemoteMessage> {
  const p = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true });
  const from = p.from?.value?.[0];
  const hasText = typeof p.text === 'string' && p.text.trim().length > 0;
  const html = typeof p.html === 'string' ? p.html : '';
  let body = '';
  let bodySource: RemoteMessage['bodySource'] = 'none';
  if (hasText) {
    body = tidy(p.text!);
    bodySource = 'plain';
  } else if (html) {
    body = htmlToText(html);
    bodySource = 'html_converted';
  }
  let truncated = !!meta.sourceTruncated;
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
    truncated = true;
  }
  const refs = (Array.isArray(p.references) ? p.references : p.references ? [p.references] : []).map((r) => normalizeMessageId(r)).filter((r): r is string => !!r);
  const date = p.date && !Number.isNaN(p.date.getTime()) ? p.date : new Date(0);
  return {
    folder: meta.folder,
    uid: meta.uid,
    messageId: normalizeMessageId(p.messageId),
    inReplyTo: normalizeMessageId(typeof p.inReplyTo === 'string' ? p.inReplyTo : null),
    references: refs.slice(-MAX_REFS),
    subject: cleanLine(p.subject ?? '', 500),
    fromName: from?.name ? cleanLine(from.name, 200) || null : null,
    fromAddr: from?.address ? cleanLine(from.address, 320).toLowerCase() : 'unknown@invalid',
    to: addrList(p.to),
    cc: addrList(p.cc),
    date: date.toISOString(),
    seen: meta.seen,
    body: cleanText(body),
    bodySource,
    truncated,
    attachments: meta.attachments ?? (p.attachments ?? []).map((a, i): RemoteAttachment => ({ partId: String(i + 1), filename: safeFilename(a.filename), mime: a.contentType || 'application/octet-stream', size: a.size ?? 0, inline: a.contentDisposition === 'inline' })),
    serverThreadId: meta.serverThreadId ?? null,
    size: meta.size ?? raw.length,
  };
}

/** imapflow BODYSTRUCTURE node (subset) */
export interface StructNode {
  part?: string;
  type?: string;
  parameters?: Record<string, string>;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  size?: number;
  encoding?: string;
  childNodes?: StructNode[];
}

/** Lists the downloadable parts (attachments + inline files) from a BODYSTRUCTURE tree. */
export function attachmentsFromStructure(root: StructNode | undefined): RemoteAttachment[] {
  const out: RemoteAttachment[] = [];
  const walk = (n: StructNode, isRoot: boolean) => {
    const type = (n.type ?? '').toLowerCase();
    if (type.startsWith('multipart/') || n.childNodes?.length) {
      for (const c of n.childNodes ?? []) walk(c, false);
      return;
    }
    const partId = n.part ?? (isRoot ? '1' : undefined);
    if (!partId) return;
    const filenameRaw = n.dispositionParameters?.filename ?? n.parameters?.name;
    const disp = (n.disposition ?? '').toLowerCase();
    const isBodyText = (type === 'text/plain' || type === 'text/html') && disp !== 'attachment' && !filenameRaw;
    if (isBodyText) return;
    if (type === 'text/calendar' && disp !== 'attachment' && !filenameRaw) return;
    if (out.length >= 100) return;
    out.push({
      partId,
      filename: safeFilename(filenameRaw, type === 'message/rfc822' ? 'forwarded-message.eml' : 'attachment'),
      mime: type || 'application/octet-stream',
      // BODYSTRUCTURE reports the transfer-encoded size; base64 inflates by 4/3
      size: Math.max(0, Math.floor((n.size ?? 0) * ((n.encoding ?? '').toLowerCase() === 'base64' ? 0.75 : 1))),
      inline: disp === 'inline',
    });
  };
  if (root) walk(root, true);
  return out;
}
