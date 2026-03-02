import type { Outcome } from "@clawseum/shared-types";
import { assertOutcome, assertPositiveShares, type AmmEngine } from "./types.js";

// Binary CPMM with reserve invariant: yesReserve * noReserve = k.
// Price interpretation follows fixed-product prediction pools.
export class CPMMBinaryMarketMaker implements AmmEngine {
  readonly kind = "CPMM" as const;
  private yesReserve: number;
  private noReserve: number;

  constructor({ initialLiquidity = 500 }: { initialLiquidity?: number } = {}) {
    if (initialLiquidity <= 0) throw new Error("initialLiquidity must be > 0");
    this.yesReserve = initialLiquidity;
    this.noReserve = initialLiquidity;
  }

  private invariant(): number {
    return this.yesReserve * this.noReserve;
  }

  private probabilityYes(): number {
    return this.noReserve / (this.yesReserve + this.noReserve);
  }

  quoteBuy(outcome: Outcome, shares: number): number {
    assertOutcome(outcome);
    assertPositiveShares(shares);

    if (outcome === "YES") {
      if (shares >= this.yesReserve) throw new Error("Buy size too large for YES reserve");
      const newYes = this.yesReserve - shares;
      const newNo = this.invariant() / newYes;
      return newNo - this.noReserve;
    }

    if (shares >= this.noReserve) throw new Error("Buy size too large for NO reserve");
    const newNo = this.noReserve - shares;
    const newYes = this.invariant() / newNo;
    return newYes - this.yesReserve;
  }

  applyBuy(outcome: Outcome, shares: number): number {
    const cost = this.quoteBuy(outcome, shares);

    if (outcome === "YES") {
      this.yesReserve -= shares;
      this.noReserve += cost;
    } else {
      this.noReserve -= shares;
      this.yesReserve += cost;
    }

    return cost;
  }

  quoteSell(outcome: Outcome, shares: number): number {
    assertOutcome(outcome);
    assertPositiveShares(shares);

    if (outcome === "YES") {
      const newYes = this.yesReserve + shares;
      const newNo = this.invariant() / newYes;
      return this.noReserve - newNo;
    }

    const newNo = this.noReserve + shares;
    const newYes = this.invariant() / newNo;
    return this.yesReserve - newYes;
  }

  applySell(outcome: Outcome, shares: number): number {
    const payout = this.quoteSell(outcome, shares);

    if (outcome === "YES") {
      this.yesReserve += shares;
      this.noReserve -= payout;
    } else {
      this.noReserve += shares;
      this.yesReserve -= payout;
    }

    return payout;
  }

  state() {
    const priceYes = this.probabilityYes();
    return {
      yesReserve: this.yesReserve,
      noReserve: this.noReserve,
      k: this.invariant(),
      priceYes,
      priceNo: 1 - priceYes,
    };
  }
}
