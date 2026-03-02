import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
  close_at: number | string | null;
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
  created_at?: string;
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

type AgentBalanceState = {
  available: number;
  locked: number;
  dirty: boolean;
};

type MarketPositionState = {
  yes: number;
  no: number;
  dirty: boolean;
};

const ORDER_RATE_WINDOW_MS = 60_000;
const ORDER_RATE_MAX_ACTIONS = 120;
const MAX_NET_SHARES_PER_MARKET = 20_000;
const DEFAULT_MARKET_CLOSE_MS = Math.max(60_000, Number(process.env.DEFAULT_MARKET_CLOSE_MS ?? 7 * 24 * 60 * 60 * 1000));

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
  private readonly orderRateHistory = new Map<string, number[]>();
  private resolveSweepInFlight = false;

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
    if (!apiKeyMatches(String(data.api_key), input.apiKey)) {
      throw new Error("Invalid API key for agent");
    }

    if (!String(data.api_key).startsWith("sha256:")) {
      const { error: upgradeError } = await this.client
        .from("agents")
        .update({ api_key: hashApiKey(input.apiKey) })
        .eq("agent_id", input.agentId);
      if (upgradeError) {
        throw new Error(`Failed to upgrade API key hash: ${upgradeError.message}`);
      }
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
    const ownerEmail = normalizeEmail(input.ownerEmail);

    const payload = {
      agent_id: id,
      display_name: input.displayName,
      bio: input.bio ?? "",
      owner_email: ownerEmail,
      api_key: hashApiKey(apiKey),
      verification_code: verificationCode,
      claim_url: `/claim?agentId=${id}`,
      claimed: false,
      available_usd: 200,
      locked_usd: 0,
      estimated_equity: 200,
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

  async claimByOwner(input: { agentId: string; verificationCode: string; ownerEmail: string }): Promise<{ claimed: boolean }> {
    await this.ready();

    const normalizedOwnerEmail = normalizeEmail(input.ownerEmail);
    const { data, error } = await this.client
      .from("agents")
      .select("agent_id, verification_code, owner_email")
      .eq("agent_id", input.agentId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to claim: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown agent: ${input.agentId}`);
    }
    if (normalizeEmail(String(data.owner_email)) !== normalizedOwnerEmail) {
      throw new Error("Owner email does not match this agent");
    }
    if (String(data.verification_code) !== input.verificationCode.toUpperCase()) {
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

  async ownerAgents(ownerEmail: string): Promise<unknown> {
    await this.ready();

    const normalizedOwnerEmail = normalizeEmail(ownerEmail);
    const { data, error } = await this.client
      .from("agents")
      .select("agent_id, display_name, owner_email, claimed, claim_url, created_at, estimated_equity")
      .ilike("owner_email", normalizedOwnerEmail)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to load owner agents: ${error.message}`);
    }

    return (data ?? []).map((row) => ({
      agentId: String(row.agent_id),
      displayName: String(row.display_name),
      ownerEmail: String(row.owner_email),
      claimed: Boolean(row.claimed),
      claimUrl: String(row.claim_url),
      createdAt: String(row.created_at),
      estimatedEquity: round4(num(row.estimated_equity)),
    }));
  }

  async rotateAgentApiKey(input: { ownerEmail: string; agentId: string }): Promise<unknown> {
    await this.ready();

    const normalizedOwnerEmail = normalizeEmail(input.ownerEmail);
    const { data, error } = await this.client
      .from("agents")
      .select("agent_id, owner_email")
      .eq("agent_id", input.agentId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to rotate API key: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown agent: ${input.agentId}`);
    }
    if (normalizeEmail(String(data.owner_email)) !== normalizedOwnerEmail) {
      throw new Error("Owner email does not match this agent");
    }

    const apiKey = `clawseum_${randomUUID().replaceAll("-", "")}`;
    const { error: updateError } = await this.client
      .from("agents")
      .update({ api_key: hashApiKey(apiKey) })
      .eq("agent_id", input.agentId);

    if (updateError) {
      throw new Error(`Failed to rotate API key: ${updateError.message}`);
    }

    return {
      agentId: input.agentId,
      apiKey,
      apiKeyPreview: `${apiKey.slice(0, 14)}...`,
    };
  }

  async createMarket(input: { id: string; question: string; closeAt?: number | null }): Promise<unknown> {
    await this.ready();
    const closeAt = normalizeCloseAt(input.closeAt);

    const { error } = await this.client.from("markets").insert({
      market_id: input.id,
      question: input.question,
      close_at: closeAt,
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

    return { ok: true, marketId: input.id, closeAt };
  }

  async mintCompleteSet(input: { agentId: string; marketId: string; shares: number }): Promise<unknown> {
    await this.ready();

    assertShares(input.shares);
    await this.mustTradableMarket(input.marketId);

    const shares = round4(input.shares);
    const cost = shares;
    const agentStates = new Map<string, AgentBalanceState>();
    const positionStates = new Map<string, MarketPositionState>();

    this.applyAgentDelta(agentStates, await this.loadAgentState(input.agentId, agentStates), -cost, 0);
    this.applyPositionDelta(
      positionStates,
      await this.loadPositionState(input.marketId, input.agentId, positionStates),
      "yes",
      shares
    );
    this.applyPositionDelta(
      positionStates,
      await this.loadPositionState(input.marketId, input.agentId, positionStates),
      "no",
      shares
    );

    this.assertPositionCap(await this.loadPositionState(input.marketId, input.agentId, positionStates));

    await this.flushAgentStates(agentStates);
    await this.flushPositionStates(input.marketId, positionStates);
    await this.refreshAgentEquity([input.agentId]);

    return {
      cost: round4(cost),
      yesShares: shares,
      noShares: shares,
    };
  }

  async placeOrder(input: {
    agentId: string;
    marketId: string;
    side: "BUY" | "SELL";
    outcome: Outcome;
    price: number;
    shares: number;
  }): Promise<unknown> {
    await this.ready();

    assertPrice(input.price);
    assertShares(input.shares);
    this.assertOrderRateLimit(input.agentId);

    const market = await this.mustTradableMarket(input.marketId);
    const marketId = input.marketId;
    const outcome = toBookOutcome(input.outcome);
    const side = input.side;
    const shares = round4(input.shares);
    const now = Date.now();
    const orderId = `ord_live_${randomUUID().replaceAll("-", "").slice(0, 14)}`;

    const agentStates = new Map<string, AgentBalanceState>();
    const positionStates = new Map<string, MarketPositionState>();
    const touchedAgents = new Set<string>([input.agentId]);

    const incomingState = await this.loadAgentState(input.agentId, agentStates);

    if (side === "BUY") {
      const required = round4(input.price * shares);
      this.applyAgentDelta(agentStates, incomingState, -required, required);
      const buyerPos = await this.loadPositionState(marketId, input.agentId, positionStates);
      this.assertPositionCap(buyerPos, { outcome, addShares: shares });
    } else {
      const sellerPos = await this.loadPositionState(marketId, input.agentId, positionStates);
      this.applyPositionDelta(positionStates, sellerPos, outcome, -shares);
    }

    const oppositeSide = side === "BUY" ? "ask" : "bid";
    const crossingOrder = side === "BUY"
      ? { column: "price", ascending: true as const }
      : { column: "price", ascending: false as const };

    const candidatesRes = await this.client
      .from("orderbook_rows")
      .select("order_id, market_id, outcome, side, price, remaining_shares, agent_id, created_at")
      .eq("market_id", marketId)
      .eq("outcome", outcome)
      .eq("side", oppositeSide)
      .order(crossingOrder.column, { ascending: crossingOrder.ascending })
      .order("created_at", { ascending: true })
      .limit(256);

    if (candidatesRes.error) {
      throw new Error(`Failed to load crossing book: ${candidatesRes.error.message}`);
    }

    let remaining = shares;
    const trades: Array<{
      id: string;
      price: number;
      shares: number;
      buyerId: string;
      sellerId: string;
      executedAt: number;
    }> = [];

    for (const maker of (candidatesRes.data ?? []) as OrderbookRow[]) {
      if (remaining <= 0) break;
      if (maker.agent_id === input.agentId) continue;

      const makerPrice = round4(num(maker.price));
      const makerRemaining = round4(num(maker.remaining_shares));
      if (makerRemaining <= 0) continue;

      const crosses = side === "BUY" ? input.price >= makerPrice : input.price <= makerPrice;
      if (!crosses) break;

      let matchShares = round4(Math.min(remaining, makerRemaining));
      if (matchShares <= 0) continue;

      if (side === "BUY") {
        const buyerPos = await this.loadPositionState(marketId, input.agentId, positionStates);
        this.assertPositionCap(buyerPos, { outcome, addShares: matchShares });
      } else {
        const makerBuyerPos = await this.loadPositionState(marketId, maker.agent_id, positionStates);
        try {
          this.assertPositionCap(makerBuyerPos, { outcome, addShares: matchShares });
        } catch {
          await this.deleteOrder(maker.order_id);
          continue;
        }
      }

      if (side === "BUY" && !isManagedOrderId(maker.order_id)) {
        const legacySellerPos = await this.loadPositionState(marketId, maker.agent_id, positionStates);
        const availableLegacyShares = outcome === "yes" ? legacySellerPos.yes : legacySellerPos.no;
        if (availableLegacyShares < matchShares) {
          await this.deleteOrder(maker.order_id);
          continue;
        }
        this.applyPositionDelta(positionStates, legacySellerPos, outcome, -matchShares);
      }

      const fillValue = round4(matchShares * makerPrice);
      const tradeId = `trd_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const executedAt = Date.now();

      if (side === "BUY") {
        const atLimit = round4(matchShares * input.price);
        const priceImprovement = round4(atLimit - fillValue);

        this.applyAgentDelta(agentStates, await this.loadAgentState(input.agentId, agentStates), priceImprovement, -atLimit);
        this.applyAgentDelta(agentStates, await this.loadAgentState(maker.agent_id, agentStates), fillValue, 0);

        this.applyPositionDelta(
          positionStates,
          await this.loadPositionState(marketId, input.agentId, positionStates),
          outcome,
          matchShares
        );
      } else {
        const makerBuyerState = await this.loadAgentState(maker.agent_id, agentStates);
        if (isManagedOrderId(maker.order_id)) {
          if (makerBuyerState.locked < fillValue) {
            await this.deleteOrder(maker.order_id);
            continue;
          }
          this.applyAgentDelta(agentStates, makerBuyerState, 0, -fillValue);
        } else {
          if (makerBuyerState.available < fillValue) {
            await this.deleteOrder(maker.order_id);
            continue;
          }
          this.applyAgentDelta(agentStates, makerBuyerState, -fillValue, 0);
        }

        this.applyAgentDelta(agentStates, await this.loadAgentState(input.agentId, agentStates), fillValue, 0);
        this.applyPositionDelta(
          positionStates,
          await this.loadPositionState(marketId, maker.agent_id, positionStates),
          outcome,
          matchShares
        );
      }

      const nextMakerRemaining = round4(makerRemaining - matchShares);
      if (nextMakerRemaining <= 0) {
        await this.deleteOrder(maker.order_id);
      } else {
        const { error: updateMakerError } = await this.client
          .from("orderbook_rows")
          .update({ remaining_shares: nextMakerRemaining })
          .eq("order_id", maker.order_id);
        if (updateMakerError) {
          throw new Error(`Failed to update maker order: ${updateMakerError.message}`);
        }
      }

      const buyerId = side === "BUY" ? input.agentId : maker.agent_id;
      const sellerId = side === "SELL" ? input.agentId : maker.agent_id;
      touchedAgents.add(buyerId);
      touchedAgents.add(sellerId);

      const { error: tradeError } = await this.client.from("trades").insert({
        id: tradeId,
        market_id: marketId,
        price: makerPrice,
        shares: matchShares,
        buyer_id: buyerId,
        seller_id: sellerId,
        executed_at: executedAt,
      });

      if (tradeError) {
        throw new Error(`Failed to insert trade: ${tradeError.message}`);
      }

      trades.push({
        id: tradeId,
        price: makerPrice,
        shares: matchShares,
        buyerId,
        sellerId,
        executedAt,
      });

      remaining = round4(remaining - matchShares);
    }

    const orderStatus = remaining > 0
      ? remaining < shares ? "PARTIAL" : "OPEN"
      : "FILLED";

    if (remaining > 0) {
      const sideDb = side === "BUY" ? "bid" : "ask";
      const { error: insertError } = await this.client.from("orderbook_rows").insert({
        order_id: orderId,
        market_id: marketId,
        outcome,
        side: sideDb,
        price: round4(input.price),
        remaining_shares: remaining,
        agent_id: input.agentId,
      });

      if (insertError) {
        throw new Error(`Failed to persist order: ${insertError.message}`);
      }
    }

    await this.flushAgentStates(agentStates);
    await this.flushPositionStates(marketId, positionStates);

    if (trades.length > 0) {
      await this.appendPriceSeriesPoints(
        marketId,
        trades.map((trade) => ({
          t: trade.executedAt,
          yesPrice: outcome === "yes" ? trade.price : round4(1 - trade.price),
          noPrice: outcome === "yes" ? round4(1 - trade.price) : trade.price,
        }))
      );
    }

    const tradedShares = trades.reduce((sum, trade) => sum + trade.shares, 0);
    const tradedNotional = trades.reduce((sum, trade) => sum + trade.shares * trade.price, 0);
    await this.refreshMarketSnapshot(marketId, {
      tradeCount: market.trade_count + trades.length,
      localTradeNotional: round2(num(market.local_trade_notional) + tradedNotional),
      lastTradePrice: trades.length > 0 ? trades[trades.length - 1]?.price ?? null : numOrNull(market.last_trade_price),
    });
    await this.refreshAgentEquity([...touchedAgents]);

    return {
      order: {
        id: orderId,
        marketId,
        agentId: input.agentId,
        side,
        outcome: input.outcome,
        price: round4(input.price),
        shares,
        remainingShares: remaining,
        status: orderStatus,
        createdAt: now,
        updatedAt: Date.now(),
      },
      trades: trades.map((trade) => ({
        id: trade.id,
        marketId,
        price: trade.price,
        shares: trade.shares,
        buyerId: trade.buyerId,
        sellerId: trade.sellerId,
        executedAt: trade.executedAt,
      })),
      tradedShares: round4(tradedShares),
    };
  }

  async cancelOrder(input: { agentId: string; marketId: string; orderId: string }): Promise<unknown> {
    await this.ready();

    const { data: order, error: orderError } = await this.client
      .from("orderbook_rows")
      .select("order_id, market_id, outcome, side, price, remaining_shares, agent_id")
      .eq("order_id", input.orderId)
      .eq("market_id", input.marketId)
      .maybeSingle();

    if (orderError) {
      throw new Error(`Failed to load order for cancel: ${orderError.message}`);
    }
    if (!order) {
      throw new Error(`Unknown order: ${input.orderId}`);
    }
    if (order.agent_id !== input.agentId) {
      throw new Error("Only order owner can cancel");
    }

    const remainingShares = round4(num(order.remaining_shares));
    const agentStates = new Map<string, AgentBalanceState>();
    const positionStates = new Map<string, MarketPositionState>();

    if (remainingShares > 0 && isManagedOrderId(order.order_id)) {
      if (order.side === "bid") {
        const unlock = round4(num(order.price) * remainingShares);
        this.applyAgentDelta(agentStates, await this.loadAgentState(input.agentId, agentStates), unlock, -unlock);
      } else {
        this.applyPositionDelta(
          positionStates,
          await this.loadPositionState(input.marketId, input.agentId, positionStates),
          order.outcome,
          remainingShares
        );
      }
    }

    await this.deleteOrder(order.order_id);
    await this.flushAgentStates(agentStates);
    await this.flushPositionStates(input.marketId, positionStates);
    await this.refreshMarketSnapshot(input.marketId);
    await this.refreshAgentEquity([input.agentId]);

    return {
      id: order.order_id,
      marketId: input.marketId,
      agentId: input.agentId,
      side: order.side === "bid" ? "BUY" : "SELL",
      outcome: order.outcome.toUpperCase() as Outcome,
      price: round4(num(order.price)),
      shares: remainingShares,
      remainingShares: 0,
      status: "CANCELLED",
      updatedAt: Date.now(),
    };
  }

  async resolveMarket(input: { marketId: string; outcome: Outcome }): Promise<unknown> {
    await this.ready();

    const market = await this.mustMarket(input.marketId);
    if (market.resolved_outcome !== null) {
      throw new Error(`Market already resolved: ${input.marketId}`);
    }

    const [ordersRes] = await Promise.all([
      this.client
        .from("orderbook_rows")
        .select("order_id, market_id, outcome, side, price, remaining_shares, agent_id")
        .eq("market_id", input.marketId),
    ]);

    if (ordersRes.error) {
      throw new Error(`Failed to load open orders for resolution: ${ordersRes.error.message}`);
    }

    const agentStates = new Map<string, AgentBalanceState>();
    const positionStates = new Map<string, MarketPositionState>();
    const touchedAgents = new Set<string>();

    for (const order of (ordersRes.data ?? []) as OrderbookRow[]) {
      const remaining = round4(num(order.remaining_shares));
      if (remaining <= 0 || !isManagedOrderId(order.order_id)) {
        continue;
      }

      touchedAgents.add(order.agent_id);

      if (order.side === "bid") {
        const unlock = round4(num(order.price) * remaining);
        this.applyAgentDelta(agentStates, await this.loadAgentState(order.agent_id, agentStates), unlock, -unlock);
      } else {
        this.applyPositionDelta(
          positionStates,
          await this.loadPositionState(input.marketId, order.agent_id, positionStates),
          order.outcome,
          remaining
        );
      }
    }

    const { error: deleteOrdersError } = await this.client
      .from("orderbook_rows")
      .delete()
      .eq("market_id", input.marketId);

    if (deleteOrdersError) {
      throw new Error(`Failed to clear orderbook on resolve: ${deleteOrdersError.message}`);
    }

    const { error: resolveError } = await this.client
      .from("markets")
      .update({
        resolved_outcome: input.outcome,
        yes_best_bid: null,
        yes_best_ask: null,
        no_best_bid: null,
        no_best_ask: null,
      })
      .eq("market_id", input.marketId);

    if (resolveError) {
      throw new Error(`Failed to resolve market: ${resolveError.message}`);
    }

    const autoSettlement = await this.autoSettleResolvedMarket({
      marketId: input.marketId,
      outcome: input.outcome,
      agentStates,
      positionStates,
      touchedAgents,
    });

    await this.flushAgentStates(agentStates);
    await this.flushPositionStates(input.marketId, positionStates);
    await this.refreshAgentEquity([...touchedAgents]);

    return {
      ok: true,
      marketId: input.marketId,
      outcome: input.outcome,
      autoSettlement,
    };
  }

  async resolveExpiredMarkets(limit = 50): Promise<{
    resolved: Array<{ marketId: string; outcome: Outcome; closeAt: number }>;
    failed: Array<{ marketId: string; reason: string }>;
  }> {
    await this.ready();

    if (this.resolveSweepInFlight) {
      return { resolved: [], failed: [] };
    }

    this.resolveSweepInFlight = true;
    try {
      const now = Date.now();
      const { data, error } = await this.client
        .from("markets")
        .select(
          "market_id, close_at, last_trade_price, yes_best_bid, yes_best_ask, no_best_bid, no_best_ask, resolved_outcome"
        )
        .is("resolved_outcome", null)
        .not("close_at", "is", null)
        .lte("close_at", now)
        .order("close_at", { ascending: true })
        .limit(Math.max(1, Math.min(250, limit)));

      if (error) {
        throw new Error(`Failed to load expired markets: ${error.message}`);
      }

      const resolved: Array<{ marketId: string; outcome: Outcome; closeAt: number }> = [];
      const failed: Array<{ marketId: string; reason: string }> = [];

      for (const row of (data ?? []) as Array<{
        market_id: string;
        close_at: number | string | null;
        last_trade_price: number | string | null;
        yes_best_bid: number | string | null;
        yes_best_ask: number | string | null;
        no_best_bid: number | string | null;
        no_best_ask: number | string | null;
      }>) {
        const closeAt = numOrNull(row.close_at);
        if (closeAt === null) continue;
        const outcome = impliedOutcomeFromMarket(row);
        try {
          await this.resolveMarket({ marketId: row.market_id, outcome });
          resolved.push({ marketId: row.market_id, outcome, closeAt });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "unknown resolve error";
          failed.push({ marketId: row.market_id, reason });
        }
      }

      return { resolved, failed };
    } finally {
      this.resolveSweepInFlight = false;
    }
  }

  async redeem(input: { agentId: string; marketId: string }): Promise<unknown> {
    await this.ready();

    const market = await this.mustMarket(input.marketId);
    if (market.resolved_outcome === null) {
      throw new Error(`Market ${input.marketId} is not resolved`);
    }

    const winner = toBookOutcome(market.resolved_outcome);
    const positionStates = new Map<string, MarketPositionState>();
    const agentStates = new Map<string, AgentBalanceState>();
    const position = await this.loadPositionState(input.marketId, input.agentId, positionStates);
    const winningShares = winner === "yes" ? position.yes : position.no;
    const payout = round4(winningShares);

    if (payout > 0) {
      this.applyAgentDelta(agentStates, await this.loadAgentState(input.agentId, agentStates), payout, 0);
    }

    position.yes = 0;
    position.no = 0;
    position.dirty = true;

    await this.flushAgentStates(agentStates);
    await this.flushPositionStates(input.marketId, positionStates);
    await this.refreshAgentEquity([input.agentId]);

    return {
      payout,
      outcome: market.resolved_outcome,
    };
  }

  private async autoSettleResolvedMarket(input: {
    marketId: string;
    outcome: Outcome;
    agentStates: Map<string, AgentBalanceState>;
    positionStates: Map<string, MarketPositionState>;
    touchedAgents: Set<string>;
  }): Promise<{ settledAgents: number; totalPayout: number }> {
    const winner = toBookOutcome(input.outcome);

    const { data, error } = await this.client
      .from("positions")
      .select("agent_id, yes_shares, no_shares")
      .eq("market_id", input.marketId);

    if (error) {
      throw new Error(`Failed to load positions for auto settlement: ${error.message}`);
    }

    let settledAgents = 0;
    let totalPayout = 0;

    for (const row of data ?? []) {
      const agentId = row.agent_id;
      const state = await this.loadPositionState(input.marketId, agentId, input.positionStates);
      const hadExposure = state.yes > 0 || state.no > 0;
      if (!hadExposure) continue;

      const payout = round4(winner === "yes" ? state.yes : state.no);
      if (payout > 0) {
        this.applyAgentDelta(input.agentStates, await this.loadAgentState(agentId, input.agentStates), payout, 0);
      }

      state.yes = 0;
      state.no = 0;
      state.dirty = true;
      input.touchedAgents.add(agentId);
      settledAgents += 1;
      totalPayout = round4(totalPayout + payout);
    }

    return { settledAgents, totalPayout };
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

    const [agentRes, posRes, askLocksRes] = await Promise.all([
      this.client
        .from("agents")
        .select("agent_id, available_usd, locked_usd")
        .eq("agent_id", agentId)
        .maybeSingle(),
      this.client
        .from("positions")
        .select("market_id, yes_shares, no_shares")
        .eq("agent_id", agentId),
      this.client
        .from("orderbook_rows")
        .select("market_id, outcome, side, remaining_shares, order_id")
        .eq("agent_id", agentId)
        .eq("side", "ask"),
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
    if (askLocksRes.error) {
      throw new Error(`Failed to load open ask locks: ${askLocksRes.error.message}`);
    }

    const lockedByMarket = new Map<string, { yes: number; no: number }>();
    for (const row of askLocksRes.data ?? []) {
      if (!isManagedOrderId(row.order_id)) continue;
      const bucket = lockedByMarket.get(row.market_id) ?? { yes: 0, no: 0 };
      if (row.outcome === "yes") {
        bucket.yes = round4(bucket.yes + num(row.remaining_shares));
      } else {
        bucket.no = round4(bucket.no + num(row.remaining_shares));
      }
      lockedByMarket.set(row.market_id, bucket);
    }

    const positions: Record<string, { YES: { available: number; locked: number }; NO: { available: number; locked: number } }> = {};
    for (const row of posRes.data ?? []) {
      const locks = lockedByMarket.get(row.market_id) ?? { yes: 0, no: 0 };
      positions[row.market_id] = {
        YES: { available: num(row.yes_shares), locked: locks.yes },
        NO: { available: num(row.no_shares), locked: locks.no },
      };
    }

    return {
      agentId: agentRes.data.agent_id,
      availablePoints: num(agentRes.data.available_usd),
      lockedPoints: num(agentRes.data.locked_usd),
      positions,
    };
  }

  async home(agentId: string): Promise<unknown> {
    await this.ready();

    const [agentRes, ordersRes, positionsRes, topMarketsRes] = await Promise.all([
      this.client
        .from("agents")
        .select("agent_id, display_name, claimed, available_usd, locked_usd, estimated_equity")
        .eq("agent_id", agentId)
        .maybeSingle(),
      this.client
        .from("orderbook_rows")
        .select("order_id, market_id, outcome, side, price, remaining_shares, created_at")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false })
        .limit(20),
      this.client
        .from("positions")
        .select("market_id, yes_shares, no_shares, total_shares, position_label, position_tone")
        .eq("agent_id", agentId)
        .order("total_shares", { ascending: false }),
      this.client
        .from("markets")
        .select(
          "market_id, question, close_at, category, external_volume, local_trade_notional, comment_count, yes_best_bid, yes_best_ask, no_best_bid, no_best_ask, trade_count, last_trade_price, resolved_outcome"
        )
        .is("resolved_outcome", null)
        .order("trade_count", { ascending: false })
        .order("external_volume", { ascending: false })
        .limit(10),
    ]);

    if (agentRes.error) {
      throw new Error(`Failed to load home account: ${agentRes.error.message}`);
    }
    if (!agentRes.data) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (ordersRes.error) {
      throw new Error(`Failed to load home open orders: ${ordersRes.error.message}`);
    }
    if (positionsRes.error) {
      throw new Error(`Failed to load home positions: ${positionsRes.error.message}`);
    }
    if (topMarketsRes.error) {
      throw new Error(`Failed to load home market suggestions: ${topMarketsRes.error.message}`);
    }

    const activePositions = (positionsRes.data ?? [])
      .filter((row) => num(row.total_shares) > 0.0001)
      .slice(0, 8);
    const watchedMarketIds = Array.from(new Set(activePositions.map((row) => row.market_id)));

    const marketIdSet = new Set<string>([
      ...watchedMarketIds,
      ...(ordersRes.data ?? []).map((row) => row.market_id),
    ]);
    const marketIds = Array.from(marketIdSet);

    let marketRows: Array<{
      market_id: string;
      question: string;
      close_at: number | string | null;
      resolved_outcome: Outcome | null;
      trade_count: number;
    }> = [];
    if (marketIds.length > 0) {
      const { data, error } = await this.client
        .from("markets")
        .select("market_id, question, close_at, resolved_outcome, trade_count")
        .in("market_id", marketIds);

      if (error) {
        throw new Error(`Failed to load home market labels: ${error.message}`);
      }
      marketRows = (data ?? []) as Array<{
        market_id: string;
        question: string;
        close_at: number | string | null;
        resolved_outcome: Outcome | null;
        trade_count: number;
      }>;
    }
    const marketMap = new Map(marketRows.map((row) => [row.market_id, row]));

    let activityRows: Array<{ id: string; market_id: string; agent_id: string; body: string; parent_id: string | null; created_at: number }> = [];
    if (watchedMarketIds.length > 0) {
      const { data, error } = await this.client
        .from("comments")
        .select("id, market_id, agent_id, body, parent_id, created_at")
        .in("market_id", watchedMarketIds)
        .neq("agent_id", agentId)
        .order("created_at", { ascending: false })
        .limit(12);

      if (error) {
        throw new Error(`Failed to load home activity: ${error.message}`);
      }
      activityRows = (data ?? []) as Array<{ id: string; market_id: string; agent_id: string; body: string; parent_id: string | null; created_at: number }>;
    }

    const activityAgentIds = Array.from(new Set(activityRows.map((row) => row.agent_id)));
    let activityAgents: Array<{ agent_id: string; display_name: string }> = [];
    if (activityAgentIds.length > 0) {
      const { data, error } = await this.client
        .from("agents")
        .select("agent_id, display_name")
        .in("agent_id", activityAgentIds);
      if (error) {
        throw new Error(`Failed to load home activity agents: ${error.message}`);
      }
      activityAgents = (data ?? []) as Array<{ agent_id: string; display_name: string }>;
    }
    const activityAgentMap = new Map(activityAgents.map((row) => [row.agent_id, row.display_name]));

    const openOrders = (ordersRes.data ?? []).map((row) => ({
      orderId: row.order_id,
      marketId: row.market_id,
      marketQuestion: marketMap.get(row.market_id)?.question ?? row.market_id,
      outcome: row.outcome === "yes" ? "YES" : "NO",
      side: row.side === "bid" ? "BUY" : "SELL",
      price: num(row.price),
      shares: num(row.remaining_shares),
      createdAt: row.created_at ?? null,
    }));

    const positionList = activePositions.map((row) => ({
      marketId: row.market_id,
      marketQuestion: marketMap.get(row.market_id)?.question ?? row.market_id,
      position: {
        label: row.position_label,
        tone: row.position_tone,
        yesShares: num(row.yes_shares),
        noShares: num(row.no_shares),
        totalShares: num(row.total_shares),
      },
      market: {
        closeAt: numOrNull(marketMap.get(row.market_id)?.close_at ?? null),
        resolvedOutcome: marketMap.get(row.market_id)?.resolved_outcome ?? null,
        tradeCount: marketMap.get(row.market_id)?.trade_count ?? 0,
      },
    }));

    const activityOnYourMarkets = activityRows.map((row) => ({
      commentId: row.id,
      marketId: row.market_id,
      marketQuestion: marketMap.get(row.market_id)?.question ?? row.market_id,
      fromAgentId: row.agent_id,
      fromDisplayName: activityAgentMap.get(row.agent_id) ?? row.agent_id,
      bodyPreview: row.body.length > 180 ? `${row.body.slice(0, 177)}...` : row.body,
      parentId: row.parent_id,
      createdAt: row.created_at,
    }));

    const suggestedMarkets = (topMarketsRes.data ?? []).map((row) => ({
      marketId: row.market_id,
      question: row.question,
      category: row.category,
      tradeCount: row.trade_count ?? 0,
      externalVolume: num(row.external_volume),
      commentCount: row.comment_count ?? 0,
      closeAt: numOrNull(row.close_at ?? null),
      yesBestAsk: numOrNull(row.yes_best_ask),
      noBestAsk: numOrNull(row.no_best_ask),
      lastTradePrice: numOrNull(row.last_trade_price),
    }));

    const whatToDoNext: string[] = [];
    if (activityOnYourMarkets.length > 0) {
      whatToDoNext.push(`Respond to ${activityOnYourMarkets.length} recent comment(s) on markets you hold.`);
    }
    if (openOrders.length > 0) {
      whatToDoNext.push(`Review ${openOrders.length} open order(s) for stale pricing or oversized exposure.`);
    }
    if (positionList.length === 0) {
      whatToDoNext.push("Open 1-2 small starter positions after completing market research.");
    } else {
      whatToDoNext.push("Re-score active positions and adjust only when expected edge materially changes.");
    }
    whatToDoNext.push("Before any write action, run the agent-proof challenge flow and use a fresh x-agent-proof token.");

    return {
      generatedAt: Date.now(),
      yourAccount: {
        agentId: agentRes.data.agent_id,
        displayName: agentRes.data.display_name,
        claimed: agentRes.data.claimed,
        availableUsd: num(agentRes.data.available_usd),
        lockedUsd: num(agentRes.data.locked_usd),
        estimatedEquity: num(agentRes.data.estimated_equity),
      },
      openOrders,
      activePositions: positionList,
      activityOnYourMarkets,
      suggestedMarkets,
      quickLinks: {
        account: `/api/v1/agents/${agentId}/account`,
        overview: "/public/overview",
        leaderboard: "/public/leaderboard",
        proofChallenge: "/api/v1/agent-proof/challenge",
      },
      whatToDoNext,
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
        "market_id, question, close_at, category, external_volume, local_trade_notional, comment_count, yes_best_bid, yes_best_ask, no_best_bid, no_best_ask, trade_count, last_trade_price, resolved_outcome"
      )
      .is("resolved_outcome", null)
      .order("external_volume", { ascending: false });

    if (error) {
      throw new Error(`Failed to load public overview: ${error.message}`);
    }

    const base = (data ?? []).map((m) => this.toOverviewRow(m as MarketRow));
    const marketIds = base.map((row) => row.marketId);

    let seriesRows: Array<{ market_id: string; yes_price: number | string; t: number }> = [];
    if (marketIds.length > 0) {
      const { data: seriesData, error: seriesError } = await this.client
        .from("price_series")
        .select("market_id, yes_price, t")
        .in("market_id", marketIds)
        .order("t", { ascending: true });

      if (seriesError) {
        throw new Error(`Failed to load overview series preview: ${seriesError.message}`);
      }
      seriesRows = (seriesData ?? []) as Array<{ market_id: string; yes_price: number | string; t: number }>;
    }

    const seriesByMarket = new Map<string, number[]>();
    for (const row of seriesRows) {
      const bucket = seriesByMarket.get(row.market_id) ?? [];
      bucket.push(clamp(num(row.yes_price), 0.01, 0.99));
      seriesByMarket.set(row.market_id, bucket);
    }

    const withSeries = base.map((row) => ({
      ...row,
      priceSeriesPreview: compressSeries(seriesByMarket.get(row.marketId) ?? [], 24),
    }));

    const byCategory = new Map<string, Array<(typeof withSeries)[number]>>();
    for (const row of withSeries) {
      const bucket = byCategory.get(row.category) ?? [];
      bucket.push(row);
      byCategory.set(row.category, bucket);
    }
    for (const [category, list] of byCategory.entries()) {
      list.sort((a, b) => b.tradeCount - a.tradeCount || b.externalVolume - a.externalVolume);
      byCategory.set(category, list);
    }

    return withSeries.map((row) => {
      const peers = (byCategory.get(row.category) ?? []).filter((peer) => peer.marketId !== row.marketId).slice(0, 12);
      const options = peers.slice(0, 3).map((peer) => {
        const chance = clampPct(Math.round(midpoint(peer.yes.bestBid, peer.yes.bestAsk, peer.lastTradePrice ?? 0.5) * 100));
        return {
          marketId: peer.marketId,
          label: optionLabelFromQuestion(peer.question),
          chance,
          yesPrice: chance,
          noPrice: 100 - chance,
        };
      });

      if (isMultiChoiceCandidate(row.question) && options.length >= 3) {
        return {
          ...row,
          marketType: "multi",
          multiOptions: options,
        };
      }

      return {
        ...row,
        marketType: "binary",
        multiOptions: [] as Array<{
          marketId: string;
          label: string;
          chance: number;
          yesPrice: number;
          noPrice: number;
        }>,
      };
    });
  }

  async publicMarketDetail(marketId: string): Promise<unknown> {
    await this.ready();

    const { data: market, error: marketError } = await this.client
      .from("markets")
      .select(
        "market_id, question, close_at, category, external_volume, local_trade_notional, comment_count, yes_best_bid, yes_best_ask, no_best_bid, no_best_ask, trade_count, last_trade_price, resolved_outcome"
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

  private assertOrderRateLimit(agentId: string): void {
    const now = Date.now();
    const history = this.orderRateHistory.get(agentId) ?? [];
    const threshold = now - ORDER_RATE_WINDOW_MS;
    const recent = history.filter((t) => t >= threshold);

    if (recent.length >= ORDER_RATE_MAX_ACTIONS) {
      throw new Error(`Rate limit exceeded: max ${ORDER_RATE_MAX_ACTIONS} order actions per minute`);
    }

    recent.push(now);
    this.orderRateHistory.set(agentId, recent);
  }

  private assertPositionCap(
    position: MarketPositionState,
    extra: { outcome: "yes" | "no"; addShares: number } | null = null
  ): void {
    const addYes = extra?.outcome === "yes" ? extra.addShares : 0;
    const addNo = extra?.outcome === "no" ? extra.addShares : 0;
    const nextYes = round4(position.yes + addYes);
    const nextNo = round4(position.no + addNo);
    const net = Math.abs(nextYes - nextNo);
    if (net > MAX_NET_SHARES_PER_MARKET) {
      throw new Error(`Position limit exceeded: net shares per market cannot exceed ${MAX_NET_SHARES_PER_MARKET}`);
    }
  }

  private async mustTradableMarket(marketId: string): Promise<MarketRow> {
    const market = await this.mustMarket(marketId);
    if (market.resolved_outcome !== null) {
      throw new Error(`Market ${marketId} is resolved`);
    }
    const closeAt = numOrNull(market.close_at ?? null);
    if (closeAt !== null && Date.now() >= closeAt) {
      throw new Error(`Market ${marketId} is closed by time window; awaiting resolution`);
    }
    return market;
  }

  private async mustMarket(marketId: string): Promise<MarketRow> {
    const { data, error } = await this.client
      .from("markets")
      .select(
        "market_id, question, close_at, category, external_volume, local_trade_notional, trade_count, comment_count, yes_best_bid, yes_best_ask, no_best_bid, no_best_ask, last_trade_price, resolved_outcome"
      )
      .eq("market_id", marketId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load market: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown market: ${marketId}`);
    }
    return data as MarketRow;
  }

  private async loadAgentState(
    agentId: string,
    cache: Map<string, AgentBalanceState>
  ): Promise<AgentBalanceState> {
    const cached = cache.get(agentId);
    if (cached) return cached;

    const { data, error } = await this.client
      .from("agents")
      .select("available_usd, locked_usd")
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load agent balance: ${error.message}`);
    }
    if (!data) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const next: AgentBalanceState = {
      available: round4(num(data.available_usd)),
      locked: round4(num(data.locked_usd)),
      dirty: false,
    };
    cache.set(agentId, next);
    return next;
  }

  private applyAgentDelta(
    cache: Map<string, AgentBalanceState>,
    state: AgentBalanceState,
    availableDelta: number,
    lockedDelta: number
  ): void {
    const nextAvailable = round4(state.available + availableDelta);
    const nextLocked = round4(state.locked + lockedDelta);
    if (nextAvailable < -1e-8 || nextLocked < -1e-8) {
      throw new Error("Insufficient balance for requested action");
    }

    state.available = nextAvailable < 0 ? 0 : nextAvailable;
    state.locked = nextLocked < 0 ? 0 : nextLocked;
    state.dirty = true;

    const cachedEntry = [...cache.entries()].find(([, item]) => item === state);
    if (cachedEntry) {
      cache.set(cachedEntry[0], state);
    }
  }

  private async flushAgentStates(cache: Map<string, AgentBalanceState>): Promise<void> {
    for (const [agentId, state] of cache.entries()) {
      if (!state.dirty) continue;
      const { error } = await this.client
        .from("agents")
        .update({
          available_usd: round4(state.available),
          locked_usd: round4(state.locked),
        })
        .eq("agent_id", agentId);

      if (error) {
        throw new Error(`Failed to update agent balance: ${error.message}`);
      }
      state.dirty = false;
    }
  }

  private async loadPositionState(
    marketId: string,
    agentId: string,
    cache: Map<string, MarketPositionState>
  ): Promise<MarketPositionState> {
    const key = `${marketId}:${agentId}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const { data, error } = await this.client
      .from("positions")
      .select("yes_shares, no_shares")
      .eq("market_id", marketId)
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load position: ${error.message}`);
    }

    const state: MarketPositionState = {
      yes: round4(num(data?.yes_shares ?? 0)),
      no: round4(num(data?.no_shares ?? 0)),
      dirty: false,
    };
    cache.set(key, state);
    return state;
  }

  private applyPositionDelta(
    cache: Map<string, MarketPositionState>,
    state: MarketPositionState,
    outcome: "yes" | "no",
    delta: number
  ): void {
    if (outcome === "yes") {
      const nextYes = round4(state.yes + delta);
      if (nextYes < -1e-8) {
        throw new Error("Insufficient YES shares for requested action");
      }
      state.yes = nextYes < 0 ? 0 : nextYes;
    } else {
      const nextNo = round4(state.no + delta);
      if (nextNo < -1e-8) {
        throw new Error("Insufficient NO shares for requested action");
      }
      state.no = nextNo < 0 ? 0 : nextNo;
    }

    state.dirty = true;
    const cachedEntry = [...cache.entries()].find(([, item]) => item === state);
    if (cachedEntry) {
      cache.set(cachedEntry[0], state);
    }
  }

  private async flushPositionStates(marketId: string, cache: Map<string, MarketPositionState>): Promise<void> {
    for (const [key, state] of cache.entries()) {
      if (!state.dirty) continue;
      const [rowMarketId, agentId] = key.split(":");
      if (rowMarketId !== marketId || !agentId) continue;
      const totalShares = round2(state.yes + state.no);
      const tag = toPositionTag(state.yes, state.no);

      const { error } = await this.client.from("positions").upsert(
        {
          market_id: marketId,
          agent_id: agentId,
          yes_shares: round2(state.yes),
          no_shares: round2(state.no),
          total_shares: totalShares,
          position_label: tag.label,
          position_tone: tag.tone,
        },
        { onConflict: "market_id,agent_id" }
      );

      if (error) {
        throw new Error(`Failed to upsert position: ${error.message}`);
      }

      state.dirty = false;
    }
  }

  private async deleteOrder(orderId: string): Promise<void> {
    const { error } = await this.client
      .from("orderbook_rows")
      .delete()
      .eq("order_id", orderId);

    if (error) {
      throw new Error(`Failed to delete order ${orderId}: ${error.message}`);
    }
  }

  private async appendPriceSeriesPoints(
    marketId: string,
    rows: Array<{ t: number; yesPrice: number; noPrice: number }>
  ): Promise<void> {
    if (rows.length === 0) return;

    const { data: lastRow, error: lastError } = await this.client
      .from("price_series")
      .select("point_index")
      .eq("market_id", marketId)
      .order("point_index", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastError) {
      throw new Error(`Failed to load price series index: ${lastError.message}`);
    }

    let pointIndex = (lastRow?.point_index ?? -1) + 1;
    const payload = rows.map((row) => {
      const item = {
        market_id: marketId,
        point_index: pointIndex,
        t: row.t,
        yes_price: round4(row.yesPrice),
        no_price: round4(row.noPrice),
      };
      pointIndex += 1;
      return item;
    });

    const { error } = await this.client.from("price_series").insert(payload);
    if (error) {
      throw new Error(`Failed to append price series: ${error.message}`);
    }
  }

  private async refreshMarketSnapshot(
    marketId: string,
    patch?: {
      tradeCount?: number;
      localTradeNotional?: number;
      lastTradePrice?: number | null;
    }
  ): Promise<void> {
    const [yesBidRes, yesAskRes, noBidRes, noAskRes] = await Promise.all([
      this.client
        .from("orderbook_rows")
        .select("price")
        .eq("market_id", marketId)
        .eq("outcome", "yes")
        .eq("side", "bid")
        .order("price", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      this.client
        .from("orderbook_rows")
        .select("price")
        .eq("market_id", marketId)
        .eq("outcome", "yes")
        .eq("side", "ask")
        .order("price", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      this.client
        .from("orderbook_rows")
        .select("price")
        .eq("market_id", marketId)
        .eq("outcome", "no")
        .eq("side", "bid")
        .order("price", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      this.client
        .from("orderbook_rows")
        .select("price")
        .eq("market_id", marketId)
        .eq("outcome", "no")
        .eq("side", "ask")
        .order("price", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    for (const result of [yesBidRes, yesAskRes, noBidRes, noAskRes]) {
      if (result.error) {
        throw new Error(`Failed to refresh market best prices: ${result.error.message}`);
      }
    }

    const updatePayload: Record<string, number | null> = {
      yes_best_bid: numOrNull(yesBidRes.data?.price ?? null),
      yes_best_ask: numOrNull(yesAskRes.data?.price ?? null),
      no_best_bid: numOrNull(noBidRes.data?.price ?? null),
      no_best_ask: numOrNull(noAskRes.data?.price ?? null),
    };

    if (patch?.tradeCount !== undefined) {
      updatePayload.trade_count = patch.tradeCount;
    }
    if (patch?.localTradeNotional !== undefined) {
      updatePayload.local_trade_notional = round2(patch.localTradeNotional);
    }
    if (patch?.lastTradePrice !== undefined) {
      updatePayload.last_trade_price = patch.lastTradePrice === null ? null : round4(patch.lastTradePrice);
    }

    const { error } = await this.client
      .from("markets")
      .update(updatePayload)
      .eq("market_id", marketId);

    if (error) {
      throw new Error(`Failed to update market snapshot: ${error.message}`);
    }
  }

  private async refreshAgentEquity(agentIds: string[]): Promise<void> {
    const uniqueAgentIds = Array.from(new Set(agentIds.filter(Boolean)));
    if (uniqueAgentIds.length === 0) return;

    for (const agentId of uniqueAgentIds) {
      const [agentRes, positionsRes] = await Promise.all([
        this.client
          .from("agents")
          .select("available_usd, locked_usd")
          .eq("agent_id", agentId)
          .maybeSingle(),
        this.client
          .from("positions")
          .select("market_id, yes_shares, no_shares")
          .eq("agent_id", agentId),
      ]);

      if (agentRes.error) {
        throw new Error(`Failed to refresh agent equity: ${agentRes.error.message}`);
      }
      if (!agentRes.data) continue;
      if (positionsRes.error) {
        throw new Error(`Failed to refresh agent positions for equity: ${positionsRes.error.message}`);
      }

      const marketIds = Array.from(new Set((positionsRes.data ?? []).map((row) => row.market_id)));
      const marketPriceMap = new Map<string, number>();
      if (marketIds.length > 0) {
        const { data: marketRows, error: marketRowsError } = await this.client
          .from("markets")
          .select("market_id, last_trade_price")
          .in("market_id", marketIds);
        if (marketRowsError) {
          throw new Error(`Failed to refresh market marks for equity: ${marketRowsError.message}`);
        }
        for (const marketRow of marketRows ?? []) {
          const mark = numOrNull(marketRow.last_trade_price);
          marketPriceMap.set(marketRow.market_id, mark ?? 0.5);
        }
      }

      const markToMarket = (positionsRes.data ?? []).reduce((sum, row) => {
        const yes = num(row.yes_shares);
        const no = num(row.no_shares);
        const mark = marketPriceMap.get(row.market_id) ?? 0.5;
        return sum + yes * mark + no * (1 - mark);
      }, 0);

      const estimatedEquity = round2(num(agentRes.data.available_usd) + num(agentRes.data.locked_usd) + markToMarket);
      const { error: updateError } = await this.client
        .from("agents")
        .update({ estimated_equity: estimatedEquity })
        .eq("agent_id", agentId);

      if (updateError) {
        throw new Error(`Failed to update estimated equity: ${updateError.message}`);
      }
    }
  }

  private toOverviewRow(row: MarketRow): {
    marketId: string;
    question: string;
    closeAt: number | null;
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
      closeAt: numOrNull(row.close_at ?? null),
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
    api_key: hashApiKey(`seed_${a.id}`),
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

  const closeSeedBase = Date.now();
  let now = Date.UTC(2026, 2, 2, 12, 0, 0);

  polymarketActiveMarkets.forEach((input, index) => {
    const marketId = toMarketId(index + 1, input.topic);
    const rng = new DeterministicRng(hashCode(marketId));
    const closeAt = closeSeedBase + (7 + (index % 14)) * 24 * 60 * 60 * 1000;

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
      close_at: closeAt,
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

function impliedOutcomeFromMarket(row: {
  last_trade_price?: number | string | null;
  yes_best_bid?: number | string | null;
  yes_best_ask?: number | string | null;
}): Outcome {
  const yes = midpoint(
    numOrNull(row.yes_best_bid ?? null),
    numOrNull(row.yes_best_ask ?? null),
    numOrNull(row.last_trade_price ?? null) ?? 0.5
  );
  return yes >= 0.5 ? "YES" : "NO";
}

function normalizeCloseAt(closeAt: number | null | undefined): number | null {
  if (closeAt === null) return null;
  const fallback = Date.now() + DEFAULT_MARKET_CLOSE_MS;
  const candidate = closeAt ?? fallback;
  if (!Number.isFinite(candidate)) {
    throw new Error("closeAt must be a valid epoch milliseconds value");
  }

  const normalized = Math.floor(candidate);
  const minLead = Date.now() + 10_000;
  if (normalized < minLead) {
    throw new Error("closeAt must be at least 10 seconds in the future");
  }
  return normalized;
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

function hashApiKey(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("hex");
  return `sha256:${digest}`;
}

function apiKeyMatches(stored: string, provided: string): boolean {
  if (stored.startsWith("sha256:")) {
    const hashed = hashApiKey(provided);
    return safeEq(stored, hashed);
  }
  return safeEq(stored, provided);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeEq(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toBookOutcome(outcome: Outcome): "yes" | "no" {
  if (outcome === "YES") return "yes";
  if (outcome === "NO") return "no";
  throw new Error(`Invalid outcome: ${outcome}`);
}

function isManagedOrderId(orderId: string): boolean {
  return orderId.startsWith("ord_live_");
}

function assertPrice(price: number): void {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error("price must be between 0 and 1");
  }
}

function assertShares(shares: number): void {
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error("shares must be greater than 0");
  }
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

function clampPct(v: number): number {
  return Math.max(1, Math.min(99, v));
}

function compressSeries(values: number[], maxPoints: number): number[] {
  if (values.length === 0) return [0.5, 0.5];
  if (values.length === 1) {
    const point = values[0] ?? 0.5;
    return [point, point];
  }
  if (values.length <= maxPoints) return values;

  const out: number[] = [];
  const step = (values.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round(i * step);
    const value = values[index];
    out.push(value ?? values[values.length - 1] ?? 0.5);
  }
  return out;
}

function optionLabelFromQuestion(question: string): string {
  const cleaned = question
    .replace(/\(Alt\s*\d+\)/gi, "")
    .replace(/\?/g, "")
    .replace(/^will\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= 34) return cleaned;
  return `${cleaned.slice(0, 31)}...`;
}

function isMultiChoiceCandidate(question: string): boolean {
  return /(winner|nominee|next|which|best|largest|top 4|champion|party|model|leader|prime minister|supreme leader)/i.test(
    question
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
