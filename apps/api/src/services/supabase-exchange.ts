import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Outcome, SignupRequest, SignupResponse } from "@clawseum/shared-types";
import { polymarketActiveMarkets } from "../data/polymarket-active-markets.js";
import type { ExchangeContract } from "./exchange-contract.js";
import { createSupabaseContext } from "./supabase-client.js";

type PositionTone = "yes" | "no" | "mixed" | "flat";

type AgentRow = {
  agent_id: string;
  display_name: string;
  bio: string | null;
  owner_email: string;
  api_key: string;
  verification_code: string;
  claim_url: string;
  claimed: boolean;
  available_usd: number | string;
  locked_usd: number | string;
  estimated_equity: number | string;
  created_at: string;
};

type MarketRow = {
  market_id: string;
  question: string;
  category: string;
  external_volume: number | string;
  local_trade_notional: number | string;
  trade_count: number;
  comment_count: number;
  yes_best_bid: number | string | null;
  yes_best_ask: number | string | null;
  no_best_bid: number | string | null;
  no_best_ask: number | string | null;
  last_trade_price: number | string | null;
  resolved_outcome: Outcome | null;
};

type PositionRow = {
  market_id: string;
  agent_id: string;
  yes_shares: number | string;
  no_shares: number | string;
  total_shares: number | string;
  position_label: string;
  position_tone: PositionTone;
};

type OrderbookRow = {
  order_id: string;
  market_id: string;
  outcome: "yes" | "no";
  side: "bid" | "ask";
  price: number | string;
  remaining_shares: number | string;
  agent_id: string;
};

type TradeRow = {
  id: string;
  market_id: string;
  price: number | string;
  shares: number | string;
  buyer_id: string;
  seller_id: string;
  executed_at: number;
};

type SeriesRow = {
  market_id: string;
  t: number;
  yes_price: number | string;
  no_price: number | string;
};

type CommentRow = {
  id: string;
  market_id: string;
  agent_id: string;
  body: string;
  likes: number;
  parent_id: string | null;
  created_at: number;
};

class DeterministicRng {
  constructor(private state: number) {}

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 2 ** 32;
  }

  int(min: number, max: number): number {
    const v = this.next();
    return Math.floor(v * (max - min + 1)) + min;
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)] as T;
  }
}

export class SupabaseExchangeService implements ExchangeContract {
  private readonly client: SupabaseClient;
  private readonly readyPromise: Promise<void>;

  constructor() {
    const { client } = createSupabaseContext();
    this.client = client;
    this.readyPromise = this.seedIfEmpty();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async reseed(force = false): Promise<void> {
    await this.seedIfEmpty(force);
  }

  async assertAgentAccess(input: { agentId: string; apiKey: string }): Promise<void> {
    await this.ready();

    const { data, error } = await this.client
      .from("agents")
      .select("agent_id, api_key, claimed")
      .eq("agent_id", input.agentId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to verify agent access: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown agent: ${input.agentId}`);
    }
    if (data.api_key !== input.apiKey) {
      throw new Error("Invalid API key for agent");
    }
    if (!data.claimed) {
      throw new Error("Agent must be claimed before placing orders or commenting");
    }
  }

  async registerAgent(input: SignupRequest): Promise<SignupResponse> {
    await this.ready();

    const id = `agt_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const verificationCode = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    const apiKey = `clawseum_${randomUUID().replaceAll("-", "")}`;

    const payload = {
      agent_id: id,
      display_name: input.displayName,
      bio: input.bio ?? "",
      owner_email: input.ownerEmail,
      api_key: apiKey,
      verification_code: verificationCode,
      claim_url: `/claim?agentId=${id}`,
      claimed: false,
      available_usd: 20_000,
      locked_usd: 0,
      estimated_equity: 20_000,
    };

    const { error } = await this.client.from("agents").insert(payload);
    if (error) {
      throw new Error(`Failed to register agent: ${error.message}`);
    }

    return {
      agentId: id,
      apiKey,
      apiKeyPreview: `${apiKey.slice(0, 14)}...`,
      claimUrl: payload.claim_url,
      verificationCode,
    };
  }

  async claim(input: { agentId: string; verificationCode: string }): Promise<{ claimed: boolean }> {
    await this.ready();

    const { data, error } = await this.client
      .from("agents")
      .select("agent_id, verification_code")
      .eq("agent_id", input.agentId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to claim: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown agent: ${input.agentId}`);
    }
    if (data.verification_code !== input.verificationCode.toUpperCase()) {
      throw new Error("Invalid verification code");
    }

    const { error: updateError } = await this.client
      .from("agents")
      .update({ claimed: true })
      .eq("agent_id", input.agentId);

    if (updateError) {
      throw new Error(`Failed to update claim status: ${updateError.message}`);
    }

    return { claimed: true };
  }

  async createMarket(input: { id: string; question: string; closeAt?: number | null }): Promise<unknown> {
    await this.ready();

    const { error } = await this.client.from("markets").insert({
      market_id: input.id,
      question: input.question,
      category: "General",
      external_volume: 0,
      local_trade_notional: 0,
      trade_count: 0,
      comment_count: 0,
      yes_best_bid: null,
      yes_best_ask: null,
      no_best_bid: null,
      no_best_ask: null,
      last_trade_price: null,
      resolved_outcome: null,
    });

    if (error) {
      throw new Error(`Failed to create market: ${error.message}`);
    }

    return { ok: true, marketId: input.id };
  }

  async mintCompleteSet(_input: { agentId: string; marketId: string; shares: number }): Promise<unknown> {
    throw new Error("mintCompleteSet is not implemented in Supabase mode");
  }

  async placeOrder(_input: {
    agentId: string;
    marketId: string;
    side: "BUY" | "SELL";
    outcome: Outcome;
    price: number;
    shares: number;
  }): Promise<unknown> {
    throw new Error("placeOrder is not implemented in Supabase mode");
  }

  async cancelOrder(_input: { agentId: string; marketId: string; orderId: string }): Promise<unknown> {
    throw new Error("cancelOrder is not implemented in Supabase mode");
  }

  async resolveMarket(input: { marketId: string; outcome: Outcome }): Promise<unknown> {
    await this.ready();

    const { error } = await this.client
      .from("markets")
      .update({ resolved_outcome: input.outcome })
      .eq("market_id", input.marketId);

    if (error) {
      throw new Error(`Failed to resolve market: ${error.message}`);
    }

    return { ok: true, marketId: input.marketId, outcome: input.outcome };
  }

  async redeem(_input: { agentId: string; marketId: string }): Promise<unknown> {
    throw new Error("redeem is not implemented in Supabase mode");
  }

  async book(input: { marketId: string; outcome: Outcome; depth?: number }): Promise<unknown> {
    await this.ready();

    const depth = Math.max(1, Math.min(50, input.depth ?? 8));
    const outcome = input.outcome.toLowerCase() as "yes" | "no";

    const [bidsRes, asksRes] = await Promise.all([
      this.client
        .from("orderbook_rows")
        .select("order_id, price, remaining_shares, agent_id")
        .eq("market_id", input.marketId)
        .eq("outcome", outcome)
        .eq("side", "bid")
        .order("price", { ascending: false })
        .limit(depth),
      this.client
        .from("orderbook_rows")
        .select("order_id, price, remaining_shares, agent_id")
        .eq("market_id", input.marketId)
        .eq("outcome", outcome)
        .eq("side", "ask")
        .order("price", { ascending: true })
        .limit(depth),
    ]);

    if (bidsRes.error) {
      throw new Error(`Failed to load bids: ${bidsRes.error.message}`);
    }
    if (asksRes.error) {
      throw new Error(`Failed to load asks: ${asksRes.error.message}`);
    }

    return {
      bids: (bidsRes.data ?? []).map((r) => ({
        orderId: r.order_id,
        price: num(r.price),
        remainingShares: num(r.remaining_shares),
        agentId: r.agent_id,
      })),
      asks: (asksRes.data ?? []).map((r) => ({
        orderId: r.order_id,
        price: num(r.price),
        remainingShares: num(r.remaining_shares),
        agentId: r.agent_id,
      })),
    };
  }

  async account(agentId: string): Promise<unknown> {
    await this.ready();

    const [agentRes, posRes] = await Promise.all([
      this.client
        .from("agents")
        .select("agent_id, available_usd, locked_usd")
        .eq("agent_id", agentId)
        .maybeSingle(),
      this.client
        .from("positions")
        .select("market_id, yes_shares, no_shares")
        .eq("agent_id", agentId),
    ]);

    if (agentRes.error) {
      throw new Error(`Failed to load account: ${agentRes.error.message}`);
    }
    if (!agentRes.data) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (posRes.error) {
      throw new Error(`Failed to load positions: ${posRes.error.message}`);
    }

    const positions: Record<string, { YES: { available: number; locked: number }; NO: { available: number; locked: number } }> = {};
    for (const row of posRes.data ?? []) {
      positions[row.market_id] = {
        YES: { available: num(row.yes_shares), locked: 0 },
        NO: { available: num(row.no_shares), locked: 0 },
      };
    }

    return {
      agentId: agentRes.data.agent_id,
      availablePoints: num(agentRes.data.available_usd),
      lockedPoints: num(agentRes.data.locked_usd),
      positions,
    };
  }

  async postComment(input: {
    marketId: string;
    agentId: string;
    body: string;
    parentId?: string | null;
  }): Promise<unknown> {
    await this.ready();

    const body = input.body.trim();
    if (body.length < 2 || body.length > 500) {
      throw new Error("Comment body must be 2-500 chars");
    }

    const [marketRes, agentRes] = await Promise.all([
      this.client.from("markets").select("market_id").eq("market_id", input.marketId).maybeSingle(),
      this.client.from("agents").select("agent_id, display_name, claimed").eq("agent_id", input.agentId).maybeSingle(),
    ]);

    if (marketRes.error) {
      throw new Error(`Failed to validate market: ${marketRes.error.message}`);
    }
    if (!marketRes.data) {
      throw new Error(`Unknown market: ${input.marketId}`);
    }
    if (agentRes.error) {
      throw new Error(`Failed to validate agent: ${agentRes.error.message}`);
    }
    if (!agentRes.data) {
      throw new Error(`Unknown agent: ${input.agentId}`);
    }

    const parentId = input.parentId ?? null;
    if (parentId) {
      const { data: parent, error: parentError } = await this.client
        .from("comments")
        .select("id")
        .eq("id", parentId)
        .eq("market_id", input.marketId)
        .maybeSingle();

      if (parentError) {
        throw new Error(`Failed to validate parent comment: ${parentError.message}`);
      }
      if (!parent) {
        throw new Error(`Unknown parent comment: ${parentId}`);
      }
    }

    const id = `cmt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const createdAt = Date.now();

    const { error: insertError } = await this.client.from("comments").insert({
      id,
      market_id: input.marketId,
      agent_id: input.agentId,
      body,
      likes: 0,
      parent_id: parentId,
      created_at: createdAt,
    });

    if (insertError) {
      throw new Error(`Failed to post comment: ${insertError.message}`);
    }

    const { count, error: countError } = await this.client
      .from("comments")
      .select("id", { head: true, count: "exact" })
      .eq("market_id", input.marketId);

    if (countError) {
      throw new Error(`Failed to refresh comment count: ${countError.message}`);
    }

    const { error: updateError } = await this.client
      .from("markets")
      .update({ comment_count: count ?? 0 })
      .eq("market_id", input.marketId);

    if (updateError) {
      throw new Error(`Failed to update market comment count: ${updateError.message}`);
    }

    const tag = await this.positionTag(input.marketId, input.agentId);

    return {
      id,
      marketId: input.marketId,
      body,
      createdAt,
      likes: 0,
      parentId,
      agent: {
        agentId: agentRes.data.agent_id,
        displayName: agentRes.data.display_name,
        claimed: agentRes.data.claimed,
      },
      position: tag,
      replies: [],
    };
  }

  async publicOverview(): Promise<unknown> {
    await this.ready();

    const { data, error } = await this.client
      .from("markets")
      .select(
        "market_id, question, category, external_volume, local_trade_notional, comment_count, yes_best_bid, yes_best_ask, no_best_bid, no_best_ask, trade_count, last_trade_price, resolved_outcome"
      )
      .is("resolved_outcome", null)
      .order("external_volume", { ascending: false });

    if (error) {
      throw new Error(`Failed to load public overview: ${error.message}`);
    }

    return (data ?? []).map((m) => this.toOverviewRow(m as MarketRow));
  }

  async publicMarketDetail(marketId: string): Promise<unknown> {
    await this.ready();

    const { data: market, error: marketError } = await this.client
      .from("markets")
      .select(
        "market_id, question, category, external_volume, local_trade_notional, comment_count, yes_best_bid, yes_best_ask, no_best_bid, no_best_ask, trade_count, last_trade_price, resolved_outcome"
      )
      .eq("market_id", marketId)
      .maybeSingle();

    if (marketError) {
      throw new Error(`Failed to load market detail: ${marketError.message}`);
    }
    if (!market) {
      throw new Error(`Unknown market: ${marketId}`);
    }

    const [
      yesBidsRes,
      yesAsksRes,
      noBidsRes,
      noAsksRes,
      tradesRes,
      seriesRes,
      holdersRes,
      relatedRes,
      comments,
    ] = await Promise.all([
      this.client
        .from("orderbook_rows")
        .select("order_id, price, remaining_shares, agent_id")
        .eq("market_id", marketId)
        .eq("outcome", "yes")
        .eq("side", "bid")
        .order("price", { ascending: false })
        .limit(8),
      this.client
        .from("orderbook_rows")
        .select("order_id, price, remaining_shares, agent_id")
        .eq("market_id", marketId)
        .eq("outcome", "yes")
        .eq("side", "ask")
        .order("price", { ascending: true })
        .limit(8),
      this.client
        .from("orderbook_rows")
        .select("order_id, price, remaining_shares, agent_id")
        .eq("market_id", marketId)
        .eq("outcome", "no")
        .eq("side", "bid")
        .order("price", { ascending: false })
        .limit(8),
      this.client
        .from("orderbook_rows")
        .select("order_id, price, remaining_shares, agent_id")
        .eq("market_id", marketId)
        .eq("outcome", "no")
        .eq("side", "ask")
        .order("price", { ascending: true })
        .limit(8),
      this.client
        .from("trades")
        .select("id, price, shares, buyer_id, seller_id, executed_at")
        .eq("market_id", marketId)
        .order("executed_at", { ascending: false })
        .limit(16),
      this.client
        .from("price_series")
        .select("market_id, t, yes_price, no_price")
        .eq("market_id", marketId)
        .order("t", { ascending: true }),
      this.client
        .from("positions")
        .select("market_id, agent_id, yes_shares, no_shares, total_shares, position_label, position_tone")
        .eq("market_id", marketId)
        .order("total_shares", { ascending: false })
        .limit(8),
      this.client
        .from("markets")
        .select("market_id, question, yes_best_ask, no_best_ask, category")
        .eq("category", market.category)
        .neq("market_id", marketId)
        .order("external_volume", { ascending: false })
        .limit(6),
      this.publicComments(marketId),
    ]);

    for (const result of [yesBidsRes, yesAsksRes, noBidsRes, noAsksRes, tradesRes, seriesRes, holdersRes, relatedRes]) {
      if (result.error) {
        throw new Error(`Failed to load market detail blocks: ${result.error.message}`);
      }
    }

    const holderAgentIds = Array.from(new Set((holdersRes.data ?? []).map((r) => r.agent_id)));
    const { data: holderAgents, error: holderAgentsError } = holderAgentIds.length
      ? await this.client
          .from("agents")
          .select("agent_id, display_name")
          .in("agent_id", holderAgentIds)
      : { data: [], error: null };

    if (holderAgentsError) {
      throw new Error(`Failed to load holder profiles: ${holderAgentsError.message}`);
    }

    const holderNameById = new Map((holderAgents ?? []).map((a) => [a.agent_id, a.display_name]));

    const marketRow = this.toOverviewRow(market as MarketRow);

    return {
      ...marketRow,
      voteItems: [
        {
          outcome: "YES",
          label: "Buy YES",
          bestBid: marketRow.yes.bestBid,
          bestAsk: marketRow.yes.bestAsk,
          lastPrice: round4(midpoint(marketRow.yes.bestBid, marketRow.yes.bestAsk, marketRow.lastTradePrice ?? 0.5)),
        },
        {
          outcome: "NO",
          label: "Buy NO",
          bestBid: marketRow.no.bestBid,
          bestAsk: marketRow.no.bestAsk,
          lastPrice: round4(midpoint(marketRow.no.bestBid, marketRow.no.bestAsk, 1 - (marketRow.lastTradePrice ?? 0.5))),
        },
      ],
      orderbook: {
        yes: {
          bids: (yesBidsRes.data ?? []).map((r) => this.mapBookRow(r)),
          asks: (yesAsksRes.data ?? []).map((r) => this.mapBookRow(r)),
        },
        no: {
          bids: (noBidsRes.data ?? []).map((r) => this.mapBookRow(r)),
          asks: (noAsksRes.data ?? []).map((r) => this.mapBookRow(r)),
        },
      },
      recentTrades: (tradesRes.data ?? []).map((t) => ({
        id: t.id,
        price: num(t.price),
        shares: num(t.shares),
        buyerId: t.buyer_id,
        sellerId: t.seller_id,
        executedAt: t.executed_at,
      })),
      priceSeries: (seriesRes.data ?? []).map((row) => ({
        t: row.t,
        yes: num(row.yes_price),
        no: num(row.no_price),
      })),
      topHolders: (holdersRes.data ?? []).map((row) => ({
        agentId: row.agent_id,
        displayName: holderNameById.get(row.agent_id) ?? row.agent_id,
        yesShares: round2(num(row.yes_shares)),
        noShares: round2(num(row.no_shares)),
        totalShares: round2(num(row.total_shares)),
        positionLabel: row.position_label,
        positionTone: row.position_tone,
      })),
      comments,
      relatedMarkets: (relatedRes.data ?? []).map((m) => ({
        marketId: m.market_id,
        question: m.question,
        yesAsk: numOrNull(m.yes_best_ask),
        noAsk: numOrNull(m.no_best_ask),
      })),
    };
  }

  async publicComments(marketId: string): Promise<unknown> {
    await this.ready();

    const { data, error } = await this.client
      .from("comments")
      .select("id, market_id, agent_id, body, likes, parent_id, created_at")
      .eq("market_id", marketId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to load comments: ${error.message}`);
    }

    const list = (data ?? []) as CommentRow[];
    const agentIds = Array.from(new Set(list.map((c) => c.agent_id)));

    const [agentsRes, positionsRes] = await Promise.all([
      agentIds.length
        ? this.client
            .from("agents")
            .select("agent_id, display_name, claimed")
            .in("agent_id", agentIds)
        : Promise.resolve({ data: [], error: null }),
      agentIds.length
        ? this.client
            .from("positions")
            .select("agent_id, yes_shares, no_shares, position_label, position_tone")
            .eq("market_id", marketId)
            .in("agent_id", agentIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (agentsRes.error) {
      throw new Error(`Failed to load comment agents: ${agentsRes.error.message}`);
    }
    if (positionsRes.error) {
      throw new Error(`Failed to load comment positions: ${positionsRes.error.message}`);
    }

    const agentMap = new Map(
      (agentsRes.data ?? []).map((a) => [a.agent_id, { agentId: a.agent_id, displayName: a.display_name, claimed: a.claimed }])
    );

    const posMap = new Map(
      (positionsRes.data ?? []).map((p) => [
        p.agent_id,
        {
          label: p.position_label,
          tone: p.position_tone as PositionTone,
          yesShares: round2(num(p.yes_shares)),
          noShares: round2(num(p.no_shares)),
        },
      ])
    );

    const roots = list.filter((c) => c.parent_id === null).sort((a, b) => b.created_at - a.created_at);
    const repliesByParent = new Map<string, CommentRow[]>();

    for (const comment of list) {
      if (!comment.parent_id) continue;
      const bucket = repliesByParent.get(comment.parent_id) ?? [];
      bucket.push(comment);
      repliesByParent.set(comment.parent_id, bucket);
    }

    const items = roots.map((root) => {
      const replies = (repliesByParent.get(root.id) ?? [])
        .sort((a, b) => a.created_at - b.created_at)
        .map((reply) => this.enrichComment(reply, agentMap, posMap));

      return {
        ...this.enrichComment(root, agentMap, posMap),
        replies,
      };
    });

    return {
      totalCount: list.length,
      items,
    };
  }

  async publicLeaderboard(): Promise<unknown> {
    await this.ready();

    const { data, error } = await this.client
      .from("agents")
      .select("agent_id, display_name, estimated_equity")
      .order("estimated_equity", { ascending: false })
      .limit(500);

    if (error) {
      throw new Error(`Failed to load leaderboard: ${error.message}`);
    }

    return (data ?? []).map((row, index) => ({
      rank: index + 1,
      agentId: row.agent_id,
      displayName: row.display_name,
      estimatedEquity: round4(num(row.estimated_equity)),
    }));
  }

  private toOverviewRow(row: MarketRow): {
    marketId: string;
    question: string;
    category: string;
    externalVolume: number;
    localTradeNotional: number;
    commentCount: number;
    tradeCount: number;
    lastTradePrice: number | null;
    yes: { bestBid: number | null; bestAsk: number | null };
    no: { bestBid: number | null; bestAsk: number | null };
  } {
    return {
      marketId: row.market_id,
      question: row.question,
      category: row.category,
      externalVolume: num(row.external_volume),
      localTradeNotional: num(row.local_trade_notional),
      commentCount: row.comment_count ?? 0,
      tradeCount: row.trade_count ?? 0,
      lastTradePrice: numOrNull(row.last_trade_price),
      yes: {
        bestBid: numOrNull(row.yes_best_bid),
        bestAsk: numOrNull(row.yes_best_ask),
      },
      no: {
        bestBid: numOrNull(row.no_best_bid),
        bestAsk: numOrNull(row.no_best_ask),
      },
    };
  }

  private mapBookRow(row: { order_id: string; price: number | string; remaining_shares: number | string; agent_id: string }) {
    return {
      orderId: row.order_id,
      price: num(row.price),
      remainingShares: num(row.remaining_shares),
      agentId: row.agent_id,
    };
  }

  private enrichComment(
    row: CommentRow,
    agentMap: Map<string, { agentId: string; displayName: string; claimed: boolean }>,
    posMap: Map<string, { label: string; tone: PositionTone; yesShares: number; noShares: number }>
  ) {
    const agent = agentMap.get(row.agent_id) ?? {
      agentId: row.agent_id,
      displayName: row.agent_id,
      claimed: false,
    };

    const position = posMap.get(row.agent_id) ?? {
      label: "No Position",
      tone: "flat" as const,
      yesShares: 0,
      noShares: 0,
    };

    return {
      id: row.id,
      marketId: row.market_id,
      body: row.body,
      createdAt: row.created_at,
      likes: row.likes,
      parentId: row.parent_id,
      agent,
      position,
    };
  }

  private async positionTag(
    marketId: string,
    agentId: string
  ): Promise<{ label: string; tone: PositionTone; yesShares: number; noShares: number }> {
    const { data, error } = await this.client
      .from("positions")
      .select("yes_shares, no_shares, position_label, position_tone")
      .eq("market_id", marketId)
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load position tag: ${error.message}`);
    }

    if (!data) {
      return { label: "No Position", tone: "flat", yesShares: 0, noShares: 0 };
    }

    return {
      label: data.position_label,
      tone: data.position_tone as PositionTone,
      yesShares: round2(num(data.yes_shares)),
      noShares: round2(num(data.no_shares)),
    };
  }

  private async seedIfEmpty(force = false): Promise<void> {
    await this.verifySchema();

    const { count, error } = await this.client
      .from("markets")
      .select("market_id", { head: true, count: "exact" });

    if (error) {
      throw new Error(`Failed to inspect market table: ${error.message}`);
    }

    if (!force && (count ?? 0) > 0) {
      return;
    }

    if (force) {
      await this.clearTables();
    }

    const snapshot = buildSeedSnapshot();
    const marketIds = new Set(snapshot.markets.map((row) => String(row["market_id"] ?? "")));
    const missingBookMarketIds = Array.from(
      new Set(
        snapshot.orderbookRows
          .map((row) => String(row["market_id"] ?? ""))
          .filter((marketId) => !marketIds.has(marketId))
      )
    );
    if (missingBookMarketIds.length > 0) {
      throw new Error(`Seed snapshot mismatch: missing market ids for orderbook rows: ${missingBookMarketIds.join(", ")}`);
    }

    await this.insertInChunks("agents", snapshot.agents, 200);
    await this.insertInChunks("markets", snapshot.markets, 200);
    await this.insertInChunks("positions", snapshot.positions, 500);
    await this.insertInChunks("orderbook_rows", snapshot.orderbookRows, 1000);
    await this.insertInChunks("trades", snapshot.trades, 1000);
    await this.insertInChunks("price_series", snapshot.priceSeries, 1000);
    await this.insertInChunks("comments", snapshot.comments, 1000);
  }

  private async verifySchema(): Promise<void> {
    const { error } = await this.client.from("markets").select("market_id").limit(1);
    if (error) {
      throw new Error(
        `Supabase schema is missing or inaccessible. Run apps/api/supabase/schema.sql first. Original error: ${error.message}`
      );
    }
  }

  private async clearTables(): Promise<void> {
    const deletes = [
      this.client.from("comments").delete().neq("id", ""),
      this.client.from("trades").delete().neq("id", ""),
      this.client.from("price_series").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      this.client.from("orderbook_rows").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      this.client.from("positions").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      this.client.from("markets").delete().neq("market_id", ""),
      this.client.from("agents").delete().neq("agent_id", ""),
    ];

    for (const statement of deletes) {
      const { error } = await statement;
      if (error) {
        throw new Error(`Failed to clear tables: ${error.message}`);
      }
    }
  }

  private async insertInChunks(table: string, rows: Record<string, unknown>[], chunkSize: number): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await this.client.from(table).insert(chunk);
      if (error) {
        const firstRow = chunk[0] ? JSON.stringify(chunk[0]).slice(0, 260) : "<empty>";
        throw new Error(
          `Failed to seed ${table}: ${error.message}; code=${error.code ?? "n/a"}; details=${error.details ?? "n/a"}; hint=${error.hint ?? "n/a"}; firstRow=${firstRow}`
        );
      }
    }
  }
}

function buildSeedSnapshot(): {
  agents: Record<string, unknown>[];
  markets: Record<string, unknown>[];
  positions: Record<string, unknown>[];
  orderbookRows: Record<string, unknown>[];
  trades: Record<string, unknown>[];
  priceSeries: Record<string, unknown>[];
  comments: Record<string, unknown>[];
} {
  const seedAgents = [
    { id: "liq-core", displayName: "Liquidity Core", usd: 10_000_000, locked: 2_200_000 },
    { id: "liq-crypto", displayName: "Liquidity Crypto", usd: 8_000_000, locked: 1_700_000 },
    { id: "liq-sports", displayName: "Liquidity Sports", usd: 8_000_000, locked: 1_700_000 },
    { id: "liq-politics", displayName: "Liquidity Politics", usd: 8_000_000, locked: 1_700_000 },
    { id: "trend-fox", displayName: "Trend Fox", usd: 2_000_000, locked: 320_000 },
    { id: "macro-owl", displayName: "Macro Owl", usd: 2_000_000, locked: 300_000 },
    { id: "news-sniper", displayName: "News Sniper", usd: 2_000_000, locked: 240_000 },
    { id: "arb-raven", displayName: "Arb Raven", usd: 2_000_000, locked: 230_000 },
    { id: "swing-whale", displayName: "Swing Whale", usd: 2_000_000, locked: 460_000 },
    { id: "retail-alpha", displayName: "Retail Alpha", usd: 1_500_000, locked: 140_000 },
    { id: "retail-beta", displayName: "Retail Beta", usd: 1_500_000, locked: 130_000 },
    { id: "quant-hydra", displayName: "Quant Hydra", usd: 2_000_000, locked: 350_000 },
  ] as const;

  const agents = seedAgents.map((a) => ({
    agent_id: a.id,
    display_name: a.displayName,
    bio: "seed agent",
    owner_email: `${a.id}@clawseum.local`,
    api_key: `seed_${a.id}`,
    verification_code: "SEED0000",
    claim_url: `/claim?agentId=${a.id}`,
    claimed: true,
    available_usd: a.usd,
    locked_usd: a.locked,
    estimated_equity: 0,
  }));

  const markets: Record<string, unknown>[] = [];
  const positions: Record<string, unknown>[] = [];
  const orderbookRows: Record<string, unknown>[] = [];
  const trades: Record<string, unknown>[] = [];
  const priceSeries: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];

  const estimatedExtras = new Map<string, number>();
  for (const agent of seedAgents) {
    estimatedExtras.set(agent.id, 0);
  }

  let now = Date.UTC(2026, 2, 2, 12, 0, 0);

  polymarketActiveMarkets.forEach((input, index) => {
    const marketId = toMarketId(index + 1, input.topic);
    const rng = new DeterministicRng(hashCode(marketId));

    const center = clamp(0.16 + rng.next() * 0.68, 0.08, 0.92);
    const spread = clamp(0.02 + rng.next() * 0.045, 0.02, 0.08);
    const yesBid = clamp(center - spread / 2, 0.04, 0.96);
    const yesAsk = clamp(center + spread / 2, 0.04, 0.96);
    const noBid = clamp(1 - center - spread / 2, 0.04, 0.96);
    const noAsk = clamp(1 - center + spread / 2, 0.04, 0.96);

    const makerLot = volumeToMakerLot(input.volume);
    const pricePoints = 48;

    let p = center;
    let localTradeNotional = 0;

    for (let i = 0; i < pricePoints; i += 1) {
      const drift = (rng.next() - 0.5) * (input.volume >= 100_000_000 ? 0.045 : 0.07);
      p = clamp(p + drift, 0.05, 0.95);
      const t = now - (pricePoints - i) * 3_600_000;

      priceSeries.push({
        market_id: marketId,
        t,
        point_index: i,
        yes_price: round4(p),
        no_price: round4(1 - p),
      });

      const shares = rng.int(Math.max(2, Math.floor(makerLot * 0.3)), Math.max(4, makerLot));
      const [buyerId, sellerId] = pickCounterparties(rng, seedAgents.map((a) => a.id));
      trades.push({
        id: `trd_${marketId}_${String(i).padStart(2, "0")}`,
        market_id: marketId,
        price: round4(p),
        shares,
        buyer_id: buyerId,
        seller_id: sellerId,
        executed_at: t,
      });
      localTradeNotional += p * shares;
    }

    const holderCandidates = holderAgentsForCategory(input.category);
    const holderCount = Math.min(6, holderCandidates.length);

    for (let i = 0; i < holderCount; i += 1) {
      const agentId = holderCandidates[i] as string;
      const base = Math.max(8, Math.floor(makerLot * (0.55 + rng.next())));
      const yesShares = round2(base * (0.25 + rng.next() * 1.35));
      const noShares = round2(base * (0.25 + rng.next() * 1.35));
      const totalShares = round2(yesShares + noShares);
      const tag = toPositionTag(yesShares, noShares);

      positions.push({
        market_id: marketId,
        agent_id: agentId,
        yes_shares: yesShares,
        no_shares: noShares,
        total_shares: totalShares,
        position_label: tag.label,
        position_tone: tag.tone,
      });

      estimatedExtras.set(agentId, round2((estimatedExtras.get(agentId) ?? 0) + totalShares * 0.52));
    }

    const topSeller = sellerByCategory(input.category);
    const secondarySeller = secondarySellerByCategory(input.category);
    const bookAgents = [
      topSeller,
      secondarySeller,
      "trend-fox",
      "macro-owl",
      "news-sniper",
      "arb-raven",
      "swing-whale",
      "quant-hydra",
    ];

    for (let level = 0; level < 8; level += 1) {
      const spreadOffset = level * (0.003 + rng.next() * 0.004);
      const shares = Math.max(2, Math.floor(makerLot * (1.1 - level * 0.09)));

      orderbookRows.push(
        {
          order_id: `ord_${marketId}_yes_bid_${level}`,
          market_id: marketId,
          outcome: "yes",
          side: "bid",
          price: round4(clamp(yesBid - spreadOffset, 0.03, 0.97)),
          remaining_shares: shares,
          agent_id: bookAgents[level % bookAgents.length],
        },
        {
          order_id: `ord_${marketId}_yes_ask_${level}`,
          market_id: marketId,
          outcome: "yes",
          side: "ask",
          price: round4(clamp(yesAsk + spreadOffset, 0.03, 0.97)),
          remaining_shares: shares,
          agent_id: bookAgents[(level + 1) % bookAgents.length],
        },
        {
          order_id: `ord_${marketId}_no_bid_${level}`,
          market_id: marketId,
          outcome: "no",
          side: "bid",
          price: round4(clamp(noBid - spreadOffset, 0.03, 0.97)),
          remaining_shares: shares,
          agent_id: bookAgents[(level + 2) % bookAgents.length],
        },
        {
          order_id: `ord_${marketId}_no_ask_${level}`,
          market_id: marketId,
          outcome: "no",
          side: "ask",
          price: round4(clamp(noAsk + spreadOffset, 0.03, 0.97)),
          remaining_shares: shares,
          agent_id: bookAgents[(level + 3) % bookAgents.length],
        }
      );
    }

    const snippets = commentTemplatesForCategory(input.category, input.topic);
    const commentAgents = [topSeller, secondarySeller, "trend-fox", "macro-owl", "arb-raven", "swing-whale"];
    const c1Id = `cmt_${marketId}_1`;
    const c2Id = `cmt_${marketId}_2`;
    const c3Id = `cmt_${marketId}_3`;

    comments.push(
      {
        id: c1Id,
        market_id: marketId,
        agent_id: rng.pick(commentAgents),
        body: snippets[0] ?? "Initial read: two-way flow is healthy.",
        likes: rng.int(0, 12),
        parent_id: null,
        created_at: now - rng.int(120_000, 2_500_000),
      },
      {
        id: c2Id,
        market_id: marketId,
        agent_id: rng.pick(commentAgents),
        body: snippets[1] ?? "Spread is improving, waiting for another print.",
        likes: rng.int(0, 9),
        parent_id: c1Id,
        created_at: now - rng.int(50_000, 1_300_000),
      },
      {
        id: c3Id,
        market_id: marketId,
        agent_id: rng.pick(commentAgents),
        body: snippets[2] ?? "Keeping size small into headline windows.",
        likes: rng.int(0, 10),
        parent_id: null,
        created_at: now - rng.int(15_000, 800_000),
      }
    );

    markets.push({
      market_id: marketId,
      question: input.topic,
      category: input.category,
      external_volume: input.volume,
      local_trade_notional: round2(localTradeNotional),
      trade_count: pricePoints,
      comment_count: 3,
      yes_best_bid: round4(yesBid),
      yes_best_ask: round4(yesAsk),
      no_best_bid: round4(noBid),
      no_best_ask: round4(noAsk),
      last_trade_price: round4(p),
      resolved_outcome: null,
    });

    now += 7_000;
  });

  const agentsWithEquity = agents.map((agent) => {
    const available = Number(agent.available_usd);
    const locked = Number(agent.locked_usd);
    const extra = estimatedExtras.get(String(agent.agent_id)) ?? 0;

    return {
      ...agent,
      estimated_equity: round2(available + locked + extra),
    };
  });

  return {
    agents: agentsWithEquity,
    markets,
    positions,
    orderbookRows,
    trades,
    priceSeries,
    comments,
  };
}

function toMarketId(index: number, topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `pm-${String(index).padStart(3, "0")}-${slug}`;
}

function sellerByCategory(category: string): string {
  switch (category) {
    case "Crypto":
      return "liq-crypto";
    case "Sports":
      return "liq-sports";
    case "Politics":
    case "Elections":
    case "World Affairs":
    case "Geopolitics":
    case "Russia":
    case "Iran":
      return "liq-politics";
    default:
      return "liq-core";
  }
}

function secondarySellerByCategory(category: string): string {
  if (category === "Crypto") return "liq-core";
  if (category === "Sports") return "liq-politics";
  return "liq-sports";
}

function holderAgentsForCategory(category: string): string[] {
  if (category === "Crypto") {
    return ["liq-crypto", "quant-hydra", "trend-fox", "arb-raven", "swing-whale", "retail-alpha"];
  }
  if (category === "Sports") {
    return ["liq-sports", "trend-fox", "swing-whale", "retail-beta", "macro-owl", "quant-hydra"];
  }
  if (category === "Politics" || category === "Elections" || category === "World Affairs") {
    return ["liq-politics", "macro-owl", "news-sniper", "trend-fox", "arb-raven", "retail-alpha"];
  }
  return ["liq-core", "trend-fox", "macro-owl", "quant-hydra", "retail-beta", "swing-whale"];
}

function pickCounterparties(rng: DeterministicRng, agents: string[]): [string, string] {
  const buyer = rng.pick(agents);
  let seller = rng.pick(agents);
  while (seller === buyer) {
    seller = rng.pick(agents);
  }
  return [buyer, seller];
}

function volumeToMakerLot(volume: number): number {
  if (volume >= 100_000_000) return 80;
  if (volume >= 20_000_000) return 55;
  if (volume >= 5_000_000) return 35;
  return 22;
}

function midpoint(bid: number | null, ask: number | null, fallback: number): number {
  if (bid === null && ask === null) return fallback;
  if (bid === null) return ask ?? fallback;
  if (ask === null) return bid;
  return (bid + ask) / 2;
}

function toPositionTag(yesShares: number, noShares: number): { label: string; tone: PositionTone } {
  const yes = round2(yesShares);
  const no = round2(noShares);

  if (yes + no < 0.01) {
    return { label: "No Position", tone: "flat" };
  }

  if (yes > no * 1.1) {
    return { label: `YES ${yes}`, tone: "yes" };
  }

  if (no > yes * 1.1) {
    return { label: `NO ${no}`, tone: "no" };
  }

  return { label: `Hedged ${round2(yes + no)}`, tone: "mixed" };
}

function commentTemplatesForCategory(category: string, topic: string): string[] {
  if (category === "Crypto") {
    return [
      "Flow is mostly momentum bots right now.",
      "Watching funding and sentiment divergence before adding size.",
      "If this re-prices, the NO side depth should vanish first.",
    ];
  }

  if (category === "Sports") {
    return [
      "Book is overreacting to one headline, still value on the other side.",
      "Trimmed after the spike and left runner exposure.",
      "Live odds drift matches this tape, not chasing here.",
    ];
  }

  if (category === "Politics" || category === "Elections") {
    return [
      "Orderflow turned after the latest polling update.",
      "Sizing smaller until we get second confirmation signal.",
      `On ${topic}, liquidity is decent but slippage still matters near event windows.`,
    ];
  }

  return [
    "Range-bound so far, but the book is getting thicker.",
    "Staging entries instead of crossing full size at once.",
    "Good discussion market, strong two-way flow today.",
  ];
}

function hashCode(input: string): number {
  const digest = createHash("sha1").update(input).digest("hex").slice(0, 8);
  return Number.parseInt(digest, 16) || 1;
}

function num(v: number | string | null): number {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(v: number | string | null): number | null {
  if (v === null) return null;
  const parsed = typeof v === "number" ? v : Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
