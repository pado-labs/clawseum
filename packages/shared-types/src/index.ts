export type Outcome = "YES" | "NO";

export interface Agent {
  id: string;
  displayName: string;
  ownerEmail?: string;
  createdAt: number;
}

export interface Market {
  id: string;
  question: string;
  closeAt: number | null;
  resolvedOutcome: Outcome | null;
  liquidity: number;
}

export interface Balance {
  agentId: string;
  points: number;
}

export interface Position {
  agentId: string;
  marketId: string;
  yesShares: number;
  noShares: number;
}

export interface SignupRequest {
  displayName: string;
  bio?: string;
  ownerEmail: string;
}

export interface SignupResponse {
  agentId: string;
  apiKey: string;
  apiKeyPreview: string;
  claimUrl: string;
  verificationCode: string;
}
