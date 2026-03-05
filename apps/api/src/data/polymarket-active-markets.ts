export interface ExternalActiveMarket {
  topic: string;
  category: string;
  volume: number;
  /** Seed probability for the YES side (0–1). Derived from Kalshi voting_percentage / 100. */
  centerPrice?: number;
}

// ── Kalshi-derived seed markets ────────────────────────────────────────────
//
// Multi-option polls: each option is a separate binary market sharing a category.
// The API groups same-category markets that contain an isMultiChoiceCandidate
// keyword into a multi-option card at query time.
//
// Binary polls: one market per question.
//
const BASE_ACTIVE_MARKETS: ExternalActiveMarket[] = [
  // ── Who will Trump nominate as Fed Chair? (multi-option, "nominee") ───
  { topic: "Warsh: Trump Fed Chair nominee?",   category: "Trump Fed Chair Nominee", volume: 244_000_000, centerPrice: 0.44 },
  { topic: "Hassett: Trump Fed Chair nominee?", category: "Trump Fed Chair Nominee", volume: 100_000_000, centerPrice: 0.18 },
  { topic: "Shelton: Trump Fed Chair nominee?", category: "Trump Fed Chair Nominee", volume:  67_000_000, centerPrice: 0.12 },

  // ── 2028 U.S. Presidential Election Winner (multi-option, "winner") ────
  { topic: "Vance: 2028 presidential winner?",  category: "2028 Presidential Winner", volume:  76_800_000, centerPrice: 0.22 },
  { topic: "Newsom: 2028 presidential winner?", category: "2028 Presidential Winner", volume:  62_800_000, centerPrice: 0.18 },
  { topic: "Rubio: 2028 presidential winner?",  category: "2028 Presidential Winner", volume:  38_400_000, centerPrice: 0.11 },

  // ── Fed decision in March (multi-option, "which") ────────────────────
  { topic: "Which March Fed rate — hold?",       category: "Fed March Decision", volume: 189_150_000, centerPrice: 0.97 },
  { topic: "Which March Fed rate — cut 25bps?",  category: "Fed March Decision", volume:   3_900_000, centerPrice: 0.02 },
  { topic: "Which March Fed rate — cut >25bps?", category: "Fed March Decision", volume:   1_950_000, centerPrice: 0.01 },

  // ── Arnold Palmer Invitational Winner (multi-option, "winner") ──────────
  { topic: "Scheffler: Arnold Palmer winner?", category: "Arnold Palmer Invitational", volume: 8_125_000, centerPrice: 0.23 },
  { topic: "McIlroy: Arnold Palmer winner?",   category: "Arnold Palmer Invitational", volume: 5_312_500, centerPrice: 0.15 },
  { topic: "Morikawa: Arnold Palmer winner?",  category: "Arnold Palmer Invitational", volume: 3_541_667, centerPrice: 0.10 },

  // ── LIV Golf Hong Kong Champion (multi-option, "champion") ─────────────
  { topic: "Ortiz: LIV Hong Kong champion?",  category: "LIV Golf Hong Kong", volume: 2_763_158, centerPrice: 0.21 },
  { topic: "Rahm: LIV Hong Kong champion?",   category: "LIV Golf Hong Kong", volume: 1_184_211, centerPrice: 0.09 },
  { topic: "Hatton: LIV Hong Kong champion?", category: "LIV Golf Hong Kong", volume: 1_052_632, centerPrice: 0.08 },

  // ── Texas Republican Senate Nominee (multi-option, "nominee") ──────────
  { topic: "Cornyn: Texas Senate nominee?",  category: "Texas Senate Nominee", volume: 4_150_000, centerPrice: 0.83 },
  { topic: "Paxton: Texas Senate nominee?",  category: "Texas Senate Nominee", volume:   750_000, centerPrice: 0.15 },
  { topic: "W. Hunt: Texas Senate nominee?", category: "Texas Senate Nominee", volume:   100_000, centerPrice: 0.02 },

  // ── Chicago Bears Relocation (multi-option, "which") ───────────────────
  { topic: "Which Bears relocation — Illinois?", category: "Chicago Bears Relocation", volume: 3_200_000, centerPrice: 0.64 },
  { topic: "Which Bears relocation — Indiana?",  category: "Chicago Bears Relocation", volume: 1_350_000, centerPrice: 0.27 },
  { topic: "Which Bears relocation — Stay?",     category: "Chicago Bears Relocation", volume:   450_000, centerPrice: 0.09 },

  // ── Binary markets ──────────────────────────────────────────────────────
  { topic: "England vs India",                                               category: "Sports",   volume: 10_000_000, centerPrice: 0.68 },
  { topic: "Will Republicans win the Texas Senate seat?",                    category: "Politics", volume:  5_000_000, centerPrice: 0.85 },
  { topic: "Will Iran effectively close the Strait of Hormuz for 7+ days?", category: "Politics", volume:  5_000_000, centerPrice: 0.45 },
];

export function buildPolymarketActiveMarkets(): ExternalActiveMarket[] {
  return BASE_ACTIVE_MARKETS;
}

export const polymarketActiveMarkets: ExternalActiveMarket[] = buildPolymarketActiveMarkets();
