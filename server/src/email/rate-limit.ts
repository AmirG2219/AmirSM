/** Tiny in-memory sliding-window limiter (single-owner app, single process). */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(private max: number, private windowMs: number, private clock: () => number = Date.now) {}
  /** Records a hit; returns 0 if allowed, else the seconds until a hit would be allowed. */
  hit(): number {
    const t = this.clock();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.max > 0 && this.hits.length >= this.max) return Math.max(1, Math.ceil((this.hits[0]! + this.windowMs - t) / 1000));
    this.hits.push(t);
    return 0;
  }
}
