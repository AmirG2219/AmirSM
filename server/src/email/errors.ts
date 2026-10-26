/** Turns raw imapflow / nodemailer / socket errors into short, honest, human-readable messages (never containing secrets). */
import type { EmailTestErrorCode } from '../../../shared/api.js';
import { cleanLine, redact } from './sanitize.js';

export interface MappedError { code: EmailTestErrorCode; message: string }
export interface ErrorContext { protocol: 'imap' | 'smtp'; host: string; port: number; security: 'tls' | 'starttls' | 'none'; secrets?: readonly (string | undefined)[] }

const NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'ENETDOWN', 'EADDRNOTAVAIL', 'EDNS']);
const CERT_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID', 'HOSTNAME_MISMATCH']);

interface ErrLike { code?: string; message?: string; response?: string; responseText?: string; responseCode?: number; serverResponseCode?: string; authenticationFailed?: boolean; command?: string }

export function mapMailError(raw: unknown, ctx: ErrorContext): MappedError {
  const e = (raw ?? {}) as ErrLike;
  const where = `${ctx.host}:${ctx.port}`;
  const proto = ctx.protocol === 'imap' ? 'incoming (IMAP)' : 'outgoing (SMTP)';
  const serverText = redact(cleanLine([e.responseText, e.response, e.message].filter(Boolean).join(' — '), 300), ctx.secrets ?? []);
  const code = e.code ?? '';
  const msg = String(e.message ?? '');

  // --- certificate / TLS ---
  if (CERT_CODES.has(code) || /self[- ]signed|certificate (has expired|is not|verify)|unable to verify|altname|hostname\/ip does not match/i.test(msg)) {
    return { code: 'tls_error', message: `The ${proto} server at ${where} presented a security certificate that is not trusted (${cleanLine(msg, 120)}). Check the server name; the app will not connect over an unverified connection.` };
  }
  if (code === 'EPROTO' || code === 'ETLS' || /wrong version number|ssl routines|packet length too long|unknown protocol|tlsv1 alert|STARTTLS|ssl3_get_record|greeting.*tls/i.test(msg)) {
    return { code: 'tls_mismatch', message: `The ${proto} server at ${where} did not accept the encryption setting "${ctx.security === 'tls' ? 'TLS' : ctx.security === 'starttls' ? 'STARTTLS' : 'none'}". Typically: TLS for ports 993/465, STARTTLS for ports 143/587.` };
  }

  // --- authentication ---
  const authFailed = e.authenticationFailed === true || e.code === 'EAUTH' || /^(AUTHENTICATIONFAILED|AUTHORIZATIONFAILED)$/i.test(e.serverResponseCode ?? '') || (e.responseCode !== undefined && [530, 534, 535].includes(e.responseCode)) || /invalid credentials|authentication failed|auth.*(fail|rejected)|login failed|invalid login|\bLOGIN\b.*\bNO\b/i.test(msg + ' ' + (e.responseText ?? ''));
  if (authFailed) {
    if (/application-specific password|app(lication)?[- ]?(specific )?password|less secure|web ?login|web ?alert|please log in via your web browser|sign in with your app/i.test(serverText + ' ' + (e.serverResponseCode ?? ''))) {
      return { code: 'app_password_required', message: `The ${proto} server refused the login and says an app password is required. Create an app password at your provider (see the steps for your provider) and use it instead of your normal password.` };
    }
    return { code: 'auth_failed', message: `The ${proto} server rejected the username or password. Check the address, and use an app password if your provider requires one.` };
  }

  // --- reachability ---
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed? ?out|timeout|greeting not received|no greeting/i.test(msg)) {
    return { code: 'timeout', message: `The ${proto} server at ${where} did not answer in time. Check the server name, the port and the encryption setting (TLS vs STARTTLS), and your internet connection.` };
  }
  if (NET_CODES.has(code) || /ECONNREFUSED|ENOTFOUND|getaddrinfo|EHOSTUNREACH|ENETUNREACH|socket hang up|connection (closed|refused|reset)|closed unexpectedly/i.test(msg)) {
    const reason = code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EDNS' || /getaddrinfo|ENOTFOUND/.test(msg) ? 'no such server name' : code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg) ? 'connection refused' : (code || 'connection failed');
    return { code: 'host_unreachable', message: `Could not reach the ${proto} server at ${where} (${reason}). Check the server name and port, that the program (e.g. Proton Bridge) is running, and your internet connection.` };
  }

  // --- the server answered but refused something else ---
  if (e.response || e.responseText || e.serverResponseCode || e.responseCode) {
    return { code: 'server_error', message: `The ${proto} server at ${where} replied: ${serverText || 'an error'}` };
  }
  return { code: 'unknown', message: `Unexpected error talking to the ${proto} server at ${where}: ${cleanLine(redact(msg, ctx.secrets ?? []), 200) || 'unknown'}` };
}
