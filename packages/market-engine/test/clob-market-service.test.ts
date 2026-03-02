import { describe, expect, it } from "vitest";
import { ClobMarketService } from "../src/index.js";

describe("ClobMarketService", () => {
  it("matches crossing buy/sell orders", () => {
    const svc = new ClobMarketService();

    svc.createAgent({ agentId: "seller", initialPoints: 1000 });
    svc.createAgent({ agentId: "buyer", initialPoints: 1000 });
    svc.createMarket({ id: "m1", question: "Q?" });

    svc.mintCompleteSet({ agentId: "seller", marketId: "m1", shares: 20 });

    svc.placeLimitOrder({
      agentId: "seller",
      marketId: "m1",
      side: "SELL",
      outcome: "YES",
      price: 0.6,
      shares: 10,
      now: 1,
    });

    const result = svc.placeLimitOrder({
      agentId: "buyer",
      marketId: "m1",
      side: "BUY",
      outcome: "YES",
      price: 0.65,
      shares: 7,
      now: 2,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.price).toBe(0.6);
    expect(svc.account("buyer").positions.m1?.YES.available).toBe(7);
  });

  it("prevents self trade", () => {
    const svc = new ClobMarketService();

    svc.createAgent({ agentId: "a1", initialPoints: 1000 });
    svc.createMarket({ id: "m1", question: "Q?" });
    svc.mintCompleteSet({ agentId: "a1", marketId: "m1", shares: 5 });

    svc.placeLimitOrder({
      agentId: "a1",
      marketId: "m1",
      side: "SELL",
      outcome: "YES",
      price: 0.55,
      shares: 2,
      now: 1,
    });

    expect(() => {
      svc.placeLimitOrder({
        agentId: "a1",
        marketId: "m1",
        side: "BUY",
        outcome: "YES",
        price: 0.55,
        shares: 1,
        now: 2,
      });
    }).toThrow(/Self-trade prevented/);
  });
});
