/** Small, dependency-free process helpers around ffmpeg / ffprobe (no shell, args passed as an array). */
import { spawn } from 'node:child_process';

export interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CaptureOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** cap on captured stdout bytes (ffprobe json can be big for odd files) */
  maxStdout?: number;
}

/** Run a binary to completion and capture stdout/stderr. Never goes through a shell. */
export function capture(bin: string, args: string[], opts: CaptureOptions = {}): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const maxStdout = opts.maxStdout ?? 20 * 1024 * 1024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < maxStdout) stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export interface RunFfmpegOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** expected output duration in seconds; used to turn out_time into a 0..1 fraction */
  expectedSeconds: number;
  onFraction?: (fraction: number) => void;
  timeoutMs?: number;
}

export interface RunFfmpegResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  aborted: boolean;
  timedOut: boolean;
}

/** Run ffmpeg with `-progress pipe:1` parsing. Resolves (never rejects) unless the binary cannot be spawned. */
export function runFfmpeg(ffmpegPath: string, args: string[], opts: RunFfmpegOptions): Promise<RunFfmpegResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, signal: null, stderrTail: '', aborted: true, timedOut: false });
      return;
    }
    const fullArgs = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...args];
    const child = spawn(ffmpegPath, fullArgs, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line);
        if (m && opts.onFraction && opts.expectedSeconds > 0) {
          // out_time_ms is (historically) microseconds too; both keys carry microseconds.
          const sec = Number(m[1]) / 1_000_000;
          if (Number.isFinite(sec) && sec >= 0) opts.onFraction(Math.min(1, sec / opts.expectedSeconds));
        }
      }
    });
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
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, stderrTail: stderr.trim().slice(-4000), aborted, timedOut });
    });
  });
}
