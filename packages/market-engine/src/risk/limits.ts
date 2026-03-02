function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class DailyPositionLimitGuard {
  constructor(
    private readonly config: {
      maxNetSharesPerMarket: number;
      maxOpenedSharesPerDay: number;
    } = {
      maxNetSharesPerMarket: 300,
      maxOpenedSharesPerDay: 800,
    }
  ) {
    if (config.maxNetSharesPerMarket <= 0 || config.maxOpenedSharesPerDay <= 0) {
      throw new Error("position limits must be > 0");
    }
  }

  private readonly openedSharesByDay = new Map<string, number>();

  private openedKey(actorId: string, marketId: string, outcome: "YES" | "NO", now: number): string {
    return `${actorId}:${marketId}:${outcome}:${dayKey(now)}`;
  }

  assertNetWithinLimit(projectedNetShares: number): void {
    if (Math.abs(projectedNetShares) > this.config.maxNetSharesPerMarket) {
      throw new Error(`Position limit exceeded: ${projectedNetShares} > ${this.config.maxNetSharesPerMarket}`);
    }
  }

  assertOpenedSharesWithinLimit(input: {
    actorId: string;
    marketId: string;
    outcome: "YES" | "NO";
    buyShares: number;
    now?: number;
  }): void {
    const { actorId, marketId, outcome, buyShares, now = Date.now() } = input;
    if (buyShares <= 0) return;

    const key = this.openedKey(actorId, marketId, outcome, now);
    const opened = this.openedSharesByDay.get(key) ?? 0;
    const projected = opened + buyShares;
    if (projected > this.config.maxOpenedSharesPerDay) {
      throw new Error(`Daily opened shares exceeded: ${projected} > ${this.config.maxOpenedSharesPerDay}`);
    }
  }

  recordOpenedShares(input: {
    actorId: string;
    marketId: string;
    outcome: "YES" | "NO";
    buyShares: number;
    now?: number;
  }): void {
    const { actorId, marketId, outcome, buyShares, now = Date.now() } = input;
    if (buyShares <= 0) return;

    const key = this.openedKey(actorId, marketId, outcome, now);
    const opened = this.openedSharesByDay.get(key) ?? 0;
    this.openedSharesByDay.set(key, opened + buyShares);
  }
}
