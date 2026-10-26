/** Run ffmpeg and receive its stdout as raw bytes (frames / jpeg), streaming or collected. Never goes through a shell. */
import { spawn } from 'node:child_process';

export interface BinaryRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** called for every stdout chunk (streaming consumers, e.g. raw video frames) */
  onStdout?: (chunk: Buffer) => void;
  /** also keep stdout in memory (default false when onStdout is given, true otherwise) */
  collectStdout?: boolean;
  /** cap on collected bytes (default 64 MB) */
  maxStdoutBytes?: number;
}

export interface BinaryRunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export function runBinary(bin: string, args: string[], opts: BinaryRunOptions = {}): Promise<BinaryRunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, aborted: true });
      return;
    }
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = opts.collectStdout ?? !opts.onStdout;
    const max = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    child.stdout.on('data', (d: Buffer) => {
      if (opts.onStdout) {
        try {
          opts.onStdout(d);
        } catch (e) {
          child.kill('SIGKILL');
          reject(e);
          return;
        }
      }
      if (collect && size < max) {
        chunks.push(d);
        size += d.length;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim().slice(-2000), timedOut, aborted });
    });
  });
}
