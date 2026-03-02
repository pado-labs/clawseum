export class SlidingWindowRateLimiter {
  constructor(
    private readonly config: { windowMs: number; maxActions: number } = {
      windowMs: 60_000,
      maxActions: 20,
    }
  ) {
    if (config.windowMs <= 0 || config.maxActions <= 0) {
      throw new Error("windowMs and maxActions must be > 0");
    }
  }

  private readonly events = new Map<string, number[]>();

  assertAllowed(actorId: string, now = Date.now()): { used: number; remaining: number; windowMs: number } {
    const start = now - this.config.windowMs;
    const bucket = this.events.get(actorId) ?? [];
    const recent = bucket.filter((ts) => ts > start);

    if (recent.length >= this.config.maxActions) {
      throw new Error(`Rate limit exceeded for ${actorId}: ${recent.length}/${this.config.maxActions}`);
    }

    recent.push(now);
    this.events.set(actorId, recent);

    return {
      used: recent.length,
      remaining: this.config.maxActions - recent.length,
      windowMs: this.config.windowMs,
    };
  }
}
