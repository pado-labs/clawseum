export function assertNoSelfTrade(takerId: string, makerId: string): void {
  if (!takerId || !makerId) {
    throw new Error("takerId and makerId are required");
  }
  if (takerId === makerId) {
    throw new Error(`Self-trade prevented for actor ${takerId}`);
  }
}
