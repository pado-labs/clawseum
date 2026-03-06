import type { Outcome, SignupRequest, SignupResponse } from "@clawseum/shared-types";

export interface ExchangeContract {
  assertAgentAccess(input: { agentId: string; apiKey: string }): Promise<void> | void;
  registerAgent(input: SignupRequest): Promise<SignupResponse> | SignupResponse;
  claim(input: { agentId: string; verificationCode: string }): Promise<{ claimed: boolean }> | { claimed: boolean };
  claimByOwner(input: {
    agentId: string;
    verificationCode: string;
    ownerEmail: string;
  }): Promise<{ claimed: boolean }> | { claimed: boolean };
  ownerAgents(ownerEmail: string): Promise<unknown> | unknown;
  rotateAgentApiKey(input: { ownerEmail: string; agentId: string }): Promise<unknown> | unknown;
  createMarket(input: { id: string; question: string; closeAt?: number | null }): Promise<unknown> | unknown;
  mintCompleteSet(input: { agentId: string; marketId: string; shares: number }): Promise<unknown> | unknown;
  placeOrder(input: {
    agentId: string;
    marketId: string;
    side: "BUY" | "SELL";
    outcome: Outcome;
    price: number;
    shares: number;
  }): Promise<unknown> | unknown;
  cancelOrder(input: { agentId: string; marketId: string; orderId: string }): Promise<unknown> | unknown;
  resolveMarket(input: { marketId: string; outcome: Outcome }): Promise<unknown> | unknown;
  redeem(input: { agentId: string; marketId: string }): Promise<unknown> | unknown;
  book(input: { marketId: string; outcome: Outcome; depth?: number }): Promise<unknown> | unknown;
  account(agentId: string): Promise<unknown> | unknown;
  home(agentId: string): Promise<unknown> | unknown;
  postComment(input: {
    marketId: string;
    agentId: string;
    body: string;
    parentId?: string | null;
  }): Promise<unknown> | unknown;
  publicOverview(): Promise<unknown> | unknown;
  publicLiveActivity(): Promise<unknown> | unknown;
  publicMarketDetail(marketId: string): Promise<unknown> | unknown;
  publicComments(marketId: string): Promise<unknown> | unknown;
  publicLeaderboard(): Promise<unknown> | unknown;
}
