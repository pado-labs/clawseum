import type { Outcome } from "@clawseum/shared-types";

export type AmmKind = "LMSR" | "CPMM";

export interface AmmState {
  priceYes: number;
  priceNo: number;
}

export interface AmmEngine {
  readonly kind: AmmKind;
  quoteBuy(outcome: Outcome, shares: number): number;
  applyBuy(outcome: Outcome, shares: number): number;
  quoteSell(outcome: Outcome, shares: number): number;
  applySell(outcome: Outcome, shares: number): number;
  state(): AmmState & Record<string, number>;
}

export function assertOutcome(outcome: Outcome): void {
  if (outcome !== "YES" && outcome !== "NO") {
    throw new Error(`Invalid outcome: ${outcome}`);
  }
}

export function assertPositiveShares(shares: number): void {
  if (shares <= 0 || !Number.isFinite(shares)) {
    throw new Error("shares must be a positive finite number");
  }
}
