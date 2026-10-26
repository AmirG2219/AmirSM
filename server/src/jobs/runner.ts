import type { Db, Row } from '../db/index.js';
import { newId, now } from '../db/index.js';
import type { JobType } from '../../../shared/domain.js';

export class FatalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalJobError';
  }
}

export interface JobContext {
  job: Row;
  signal: AbortSignal;
  /** overall progress 0..1 is persisted immediately so the UI can poll it */
  report(stage: string, fraction: number, message: string): void;
}
export interface JobHandler {
  run(ctx: JobContext): Promise<void>;
  /** called once when the job will not be retried again (failure or cancellation) */
  onFinalFailure?(job: Row, error: Error, cancelled: boolean): void | Promise<void>;
}

export interface JobRunnerOptions {
  pollMs?: number;
  /** delay before retry n (ms) */
  backoffMs?: (attempt: number) => number;
  log?: { info(msg: string): void; error(msg: string): void };
}

const isCancel = (e: unknown) => (e as Error)?.name === 'RenderCancelled' || (e as Error)?.name === 'AbortError';
const isRetryable = (e: unknown) => {
  if (e instanceof FatalJobError) return false;
  if ((e as { retryable?: boolean }).retryable === true) return true;
  if ((e as { retryable?: boolean }).retryable === false) return false;
  return false;
};

/** Single-concurrency, SQLite-backed queue. Jobs survive restarts: anything `running` at boot is re-queued. */
export class JobRunner {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private current: { id: string; ctrl: AbortController; promise: Promise<void> } | null = null;
  private stopped = true;
  private opts: Required<Omit<JobRunnerOptions, 'log'>> & { log?: JobRunnerOptions['log'] };

  constructor(private db: Db, opts: JobRunnerOptions = {}) {
    this.opts = { pollMs: opts.pollMs ?? 500, backoffMs: opts.backoffMs ?? ((a) => 4000 * a), log: opts.log };
  }

  register(type: JobType, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  enqueue(input: { type: JobType; projectId: string; versionId: string; maxAttempts?: number }): string {
    const id = newId('job');
    const t = now();
    this.db
      .prepare('INSERT INTO jobs (id, type, project_id, version_id, status, progress, max_attempts, run_after, created_at, message) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.type, input.projectId, input.versionId, 'queued', 0, input.maxAttempts ?? 2, t, t, 'Waiting in queue');
    return id;
  }

  start() {
    this.stopped = false;
    const stale = this.db
      .prepare("UPDATE jobs SET status = 'queued', message = 'Resumed after restart', run_after = ? WHERE status = 'running'")
      .run(now());
    if (Number(stale.changes) > 0) this.opts.log?.info(`Re-queued ${stale.changes} interrupted job(s)`);
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    void this.tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current) {
      this.current.ctrl.abort();
      await this.current.promise.catch(() => undefined);
    }
  }

  /** Test helper: resolves when nothing is queued or running. */
  async idle(timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const n = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as Row;
      if (n.n === 0 && !this.current) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('JobRunner.idle timed out');
  }

  stats() {
    const r = this.db.prepare("SELECT SUM(status='queued') AS queued, SUM(status='running') AS running FROM jobs").get() as Row;
    return { queued: Number(r.queued ?? 0), running: Number(r.running ?? 0) };
  }

  cancel(jobId: string): boolean {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Row | undefined;
    if (!job) return false;
    if (job.status === 'queued') {
      this.db.prepare("UPDATE jobs SET status = 'cancelled', message = 'Cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now(), jobId);
      const h = this.handlers.get(job.type);
      void h?.onFinalFailure?.(job, new Error('Cancelled by owner'), true);
      return true;
    }
    if (job.status === 'running') {
      this.db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(jobId);
      if (this.current?.id === jobId) this.current.ctrl.abort();
      return true;
    }
    return false;
  }

  private async tick() {
    if (this.stopped || this.current) return;
    const job = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY created_at, rowid LIMIT 1").get(now()) as Row | undefined;
    if (!job) return;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(`No handler for ${job.type}`, now(), job.id);
      return;
    }
    const ctrl = new AbortController();
    const attempt = job.attempt + 1;
    this.db.prepare("UPDATE jobs SET status = 'running', attempt = ?, started_at = COALESCE(started_at, ?), error = NULL, cancel_requested = 0, message = ? WHERE id = ?").run(attempt, now(), attempt > 1 ? `Retrying (attempt ${attempt})` : 'Starting', job.id);
    const promise = this.execute({ ...job, attempt }, handler, ctrl).finally(() => {
      this.current = null;
    });
    this.current = { id: job.id, ctrl, promise };
    await promise;
    setImmediate(() => void this.tick());
  }

  private async execute(job: Row, handler: JobHandler, ctrl: AbortController) {
    const ctx: JobContext = {
      job,
      signal: ctrl.signal,
      report: (stage, fraction, message) => {
        this.db.prepare('UPDATE jobs SET stage = ?, progress = ?, message = ? WHERE id = ?').run(stage, Math.max(0, Math.min(1, fraction)), message.slice(0, 300), job.id);
      },
    };
    try {
      await handler.run(ctx);
      this.db.prepare("UPDATE jobs SET status = 'succeeded', progress = 1, message = 'Done', finished_at = ? WHERE id = ?").run(now(), job.id);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const cancelled = isCancel(err) || ctrl.signal.aborted;
      if (cancelled && this.stopped) {
        // shutting down mid-job: leave it re-queueable for next boot
        this.db.prepare("UPDATE jobs SET status = 'queued', message = 'Paused by shutdown', run_after = ? WHERE id = ?").run(now(), job.id);
        return;
      }
      if (cancelled) {
        this.db.prepare("UPDATE jobs SET status = 'cancelled', message = 'Cancelled', error = NULL, finished_at = ? WHERE id = ?").run(now(), job.id);
        await handler.onFinalFailure?.(job, new Error('Cancelled by owner'), true);
        return;
      }
      const retry = isRetryable(err) && job.attempt < job.max_attempts;
      this.opts.log?.error(`job ${job.id} attempt ${job.attempt} failed: ${err.message}`);
      if (retry) {
        const when = new Date(Date.now() + this.opts.backoffMs(job.attempt)).toISOString();
        this.db
          .prepare("UPDATE jobs SET status = 'queued', error = ?, message = ?, run_after = ? WHERE id = ?")
          .run(err.message.slice(0, 1000), `Attempt ${job.attempt} failed — retrying automatically`, when, job.id);
      } else {
        this.db.prepare("UPDATE jobs SET status = 'failed', error = ?, message = 'Failed', finished_at = ? WHERE id = ?").run(err.message.slice(0, 1000), now(), job.id);
        await handler.onFinalFailure?.(job, err, false);
      }
    }
  }
}
