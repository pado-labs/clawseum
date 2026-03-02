import type { Outcome } from "@clawseum/shared-types";
import { assertOutcome, assertPositiveShares, type AmmEngine } from "./types.js";

function expSafe(x: number): number {
  if (x > 700) return Math.exp(700);
  if (x < -700) return Math.exp(-700);
  return Math.exp(x);
}

export class LMSRBinaryMarketMaker implements AmmEngine {
  readonly kind = "LMSR" as const;
  private readonly b: number;
  private qYes: number;
  private qNo: number;

  constructor({ liquidity = 100, yesShares = 0, noShares = 0 }: { liquidity?: number; yesShares?: number; noShares?: number } = {}) {
    if (liquidity <= 0) throw new Error("liquidity must be > 0");
    this.b = liquidity;
    this.qYes = yesShares;
    this.qNo = noShares;
  }

  private cost(yesShares = this.qYes, noShares = this.qNo): number {
    const yesTerm = expSafe(yesShares / this.b);
    const noTerm = expSafe(noShares / this.b);
    return this.b * Math.log(yesTerm + noTerm);
  }

  private priceYes(): number {
    const yesTerm = expSafe(this.qYes / this.b);
    const noTerm = expSafe(this.qNo / this.b);
    return yesTerm / (yesTerm + noTerm);
  }

  quoteBuy(outcome: Outcome, shares: number): number {
    assertOutcome(outcome);
    assertPositiveShares(shares);
    const before = this.cost();
    const after = outcome === "YES" ? this.cost(this.qYes + shares, this.qNo) : this.cost(this.qYes, this.qNo + shares);
    return after - before;
  }

  applyBuy(outcome: Outcome, shares: number): number {
    const cost = this.quoteBuy(outcome, shares);
    if (outcome === "YES") this.qYes += shares;
    else this.qNo += shares;
    return cost;
  }

  quoteSell(outcome: Outcome, shares: number): number {
    assertOutcome(outcome);
    assertPositiveShares(shares);
    if (outcome === "YES" && this.qYes - shares < 0) {
      throw new Error("Cannot sell more YES inventory than market has minted");
    }
    if (outcome === "NO" && this.qNo - shares < 0) {
      throw new Error("Cannot sell more NO inventory than market has minted");
    }
    const before = this.cost();
    const after = outcome === "YES" ? this.cost(this.qYes - shares, this.qNo) : this.cost(this.qYes, this.qNo - shares);
    return before - after;
  }

  applySell(outcome: Outcome, shares: number): number {
    const payout = this.quoteSell(outcome, shares);
    if (outcome === "YES") this.qYes -= shares;
    else this.qNo -= shares;
    return payout;
  }

  state() {
    const priceYes = this.priceYes();
    return {
      b: this.b,
      qYes: this.qYes,
      qNo: this.qNo,
      priceYes,
      priceNo: 1 - priceYes,
    };
  }
}
