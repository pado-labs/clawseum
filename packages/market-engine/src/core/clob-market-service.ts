import type { Outcome } from "@clawseum/shared-types";
import { DailyPositionLimitGuard } from "../risk/limits.js";
import { SlidingWindowRateLimiter } from "../risk/rate-limit.js";
import { assertNoSelfTrade } from "../risk/self-trade.js";

export type Side = "BUY" | "SELL";
export type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED";

interface PositionBucket {
  available: number;
  locked: number;
}

type MarketPosition = Record<Outcome, PositionBucket>;

interface AgentAccount {
  agentId: string;
  availablePoints: number;
  lockedPoints: number;
  positions: Record<string, MarketPosition>;
}

export interface LimitOrder {
  id: string;
  marketId: string;
  agentId: string;
  side: Side;
  outcome: Outcome;
  price: number;
  shares: number;
  remainingShares: number;
  lockedPoints: number;
  lockedShares: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Trade {
  id: string;
  marketId: string;
  outcome: Outcome;
  price: number;
  shares: number;
  takerOrderId: string;
  makerOrderId: string;
  buyerId: string;
  sellerId: string;
  executedAt: number;
}

interface MarketBook {
  bids: string[];
  asks: string[];
}

interface MarketState {
  id: string;
  question: string;
  closeAt: number | null;
  resolvedOutcome: Outcome | null;
  orders: Map<string, LimitOrder>;
  books: Record<Outcome, MarketBook>;
  trades: Trade[];
}

function assertOutcome(outcome: Outcome): void {
  if (outcome !== "YES" && outcome !== "NO") {
    throw new Error(`Invalid outcome: ${outcome}`);
  }
}

function assertPrice(price: number): void {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error("price must be between 0 and 1");
  }
}

function assertShares(shares: number): void {
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error("shares must be > 0");
  }
}

function isMarketOpen(market: MarketState, now: number): boolean {
  if (market.resolvedOutcome !== null) return false;
  if (market.closeAt === null) return true;
  return now < market.closeAt;
}

function freshPosition(): MarketPosition {
  return {
    YES: { available: 0, locked: 0 },
    NO: { available: 0, locked: 0 },
  };
}

export class ClobMarketService {
  private readonly markets = new Map<string, MarketState>();
  private readonly accounts = new Map<string, AgentAccount>();
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly positionGuard: DailyPositionLimitGuard;

  private orderSeq = 0;
  private tradeSeq = 0;

  constructor(
    deps: {
      rateLimiter?: SlidingWindowRateLimiter;
      positionGuard?: DailyPositionLimitGuard;
    } = {}
  ) {
    this.rateLimiter = deps.rateLimiter ?? new SlidingWindowRateLimiter({ windowMs: 60_000, maxActions: 30 });
    this.positionGuard = deps.positionGuard ?? new DailyPositionLimitGuard({ maxNetSharesPerMarket: 500, maxOpenedSharesPerDay: 1000 });
  }

  createAgent(input: { agentId: string; initialPoints?: number }): AgentAccount {
    const { agentId, initialPoints = 1000 } = input;
    if (!agentId) throw new Error("agentId is required");
    if (this.accounts.has(agentId)) throw new Error(`Agent already exists: ${agentId}`);

    const account: AgentAccount = {
      agentId,
      availablePoints: initialPoints,
      lockedPoints: 0,
      positions: {},
    };
    this.accounts.set(agentId, account);
    return this.cloneAccount(account);
  }

  createMarket(input: { id: string; question: string; closeAt?: number | null }): { id: string; question: string; closeAt: number | null } {
    const { id, question, closeAt = null } = input;
    if (!id || !question) throw new Error("id and question are required");
    if (this.markets.has(id)) throw new Error(`Market already exists: ${id}`);

    this.markets.set(id, {
      id,
      question,
      closeAt,
      resolvedOutcome: null,
      orders: new Map<string, LimitOrder>(),
      books: {
        YES: { bids: [], asks: [] },
        NO: { bids: [], asks: [] },
      },
      trades: [],
    });

    return { id, question, closeAt };
  }

  mintCompleteSet(input: { agentId: string; marketId: string; shares: number }): { cost: number; yesShares: number; noShares: number } {
    const { agentId, marketId, shares } = input;
    assertShares(shares);
    this.mustMarket(marketId);
    const account = this.mustAccount(agentId);
    const position = this.marketPosition(account, marketId);

    const cost = shares;
    if (account.availablePoints < cost) {
      throw new Error(`Insufficient points: need ${cost}, have ${account.availablePoints}`);
    }

    account.availablePoints -= cost;
    position.YES.available += shares;
    position.NO.available += shares;

    return { cost, yesShares: shares, noShares: shares };
  }

  placeLimitOrder(input: {
    agentId: string;
    marketId: string;
    side: Side;
    outcome: Outcome;
    price: number;
    shares: number;
    now?: number;
  }): { order: LimitOrder; trades: Trade[] } {
    const { agentId, marketId, side, outcome, price, shares, now = Date.now() } = input;
    assertOutcome(outcome);
    assertPrice(price);
    assertShares(shares);

    const market = this.mustMarket(marketId);
    if (!isMarketOpen(market, now)) {
      throw new Error(`Market ${marketId} is closed`);
    }

    this.rateLimiter.assertAllowed(agentId, now);

    const account = this.mustAccount(agentId);
    const order: LimitOrder = {
      id: `ord_${++this.orderSeq}`,
      marketId,
      agentId,
      side,
      outcome,
      price,
      shares,
      remainingShares: shares,
      lockedPoints: 0,
      lockedShares: 0,
      status: "OPEN",
      createdAt: now,
      updatedAt: now,
    };

    this.lockForOrder(account, order);

    try {
      const trades = this.matchOrder(market, order, now);

      if (order.remainingShares > 0) {
        this.addToBook(market, order);
        this.reconcileLockedAfterPartial(order, account);
        order.status = order.remainingShares === order.shares ? "OPEN" : "PARTIAL";
      } else {
        this.releaseOrderLock(account, order);
        order.status = "FILLED";
      }

      order.updatedAt = now;
      market.orders.set(order.id, { ...order });
      return { order: { ...order }, trades };
    } catch (error) {
      this.releaseOrderLock(account, order);
      throw error;
    }
  }

  cancelOrder(input: { agentId: string; marketId: string; orderId: string }): LimitOrder {
    const { agentId, marketId, orderId } = input;
    const market = this.mustMarket(marketId);
    const order = market.orders.get(orderId);
    if (!order) throw new Error(`Unknown order: ${orderId}`);
    if (order.agentId !== agentId) throw new Error("Only order owner can cancel");
    if (order.status === "FILLED" || order.status === "CANCELLED") return { ...order };

    this.removeFromBook(market, order);
    const account = this.mustAccount(agentId);
    this.releaseOrderLock(account, order);
    order.remainingShares = 0;
    order.status = "CANCELLED";
    order.updatedAt = Date.now();
    market.orders.set(order.id, { ...order });

    return { ...order };
  }

  resolveMarket(input: { marketId: string; outcome: Outcome }): { marketId: string; resolvedOutcome: Outcome } {
    const { marketId, outcome } = input;
    assertOutcome(outcome);
    const market = this.mustMarket(marketId);

    if (market.resolvedOutcome !== null) {
      throw new Error(`Market already resolved: ${marketId}`);
    }

    for (const order of market.orders.values()) {
      if (order.status === "OPEN" || order.status === "PARTIAL") {
        const account = this.mustAccount(order.agentId);
        this.releaseOrderLock(account, order);
        order.remainingShares = 0;
        order.status = "CANCELLED";
      }
    }

    market.books.YES = { bids: [], asks: [] };
    market.books.NO = { bids: [], asks: [] };
    market.resolvedOutcome = outcome;

    return { marketId, resolvedOutcome: outcome };
  }

  redeem(input: { agentId: string; marketId: string }): { payout: number; outcome: Outcome } {
    const { agentId, marketId } = input;
    const market = this.mustMarket(marketId);
    const account = this.mustAccount(agentId);
    const position = this.marketPosition(account, marketId);

    if (market.resolvedOutcome === null) {
      throw new Error(`Market ${marketId} is not resolved`);
    }

    const winner = market.resolvedOutcome;
    const winningShares = position[winner].available + position[winner].locked;

    const payout = winningShares;
    account.availablePoints += payout;
    position.YES.available = 0;
    position.YES.locked = 0;
    position.NO.available = 0;
    position.NO.locked = 0;

    return { payout, outcome: winner };
  }

  book(input: { marketId: string; outcome: Outcome; depth?: number }): {
    bids: Array<{ orderId: string; price: number; remainingShares: number; agentId: string }>;
    asks: Array<{ orderId: string; price: number; remainingShares: number; agentId: string }>;
  } {
    const { marketId, outcome, depth = 10 } = input;
    assertOutcome(outcome);
    const market = this.mustMarket(marketId);
    const book = market.books[outcome];

    return {
      bids: book.bids.slice(0, depth).map((id) => {
        const o = market.orders.get(id);
        if (!o) throw new Error(`Missing order in book: ${id}`);
        return { orderId: o.id, price: o.price, remainingShares: o.remainingShares, agentId: o.agentId };
      }),
      asks: book.asks.slice(0, depth).map((id) => {
        const o = market.orders.get(id);
        if (!o) throw new Error(`Missing order in book: ${id}`);
        return { orderId: o.id, price: o.price, remainingShares: o.remainingShares, agentId: o.agentId };
      }),
    };
  }

  account(agentId: string): AgentAccount {
    return this.cloneAccount(this.mustAccount(agentId));
  }

  accountsSnapshot(): AgentAccount[] {
    return [...this.accounts.values()].map((account) => this.cloneAccount(account));
  }

  trades(marketId: string): Trade[] {
    return [...this.mustMarket(marketId).trades];
  }

  marketsSummary(): Array<{
    marketId: string;
    question: string;
    closeAt: number | null;
    resolvedOutcome: Outcome | null;
    yes: { bestBid: number | null; bestAsk: number | null };
    no: { bestBid: number | null; bestAsk: number | null };
    tradeCount: number;
    tradedShares: number;
    tradeNotional: number;
    lastTradePrice: number | null;
  }> {
    const out: Array<{
      marketId: string;
      question: string;
      closeAt: number | null;
      resolvedOutcome: Outcome | null;
      yes: { bestBid: number | null; bestAsk: number | null };
      no: { bestBid: number | null; bestAsk: number | null };
      tradeCount: number;
      tradedShares: number;
      tradeNotional: number;
      lastTradePrice: number | null;
    }> = [];

    for (const market of this.markets.values()) {
      const yesBids = market.books.YES.bids.map((id) => market.orders.get(id)).filter((x): x is LimitOrder => Boolean(x));
      const yesAsks = market.books.YES.asks.map((id) => market.orders.get(id)).filter((x): x is LimitOrder => Boolean(x));
      const noBids = market.books.NO.bids.map((id) => market.orders.get(id)).filter((x): x is LimitOrder => Boolean(x));
      const noAsks = market.books.NO.asks.map((id) => market.orders.get(id)).filter((x): x is LimitOrder => Boolean(x));
      const lastTrade = market.trades.at(-1);
      const tradedShares = market.trades.reduce((acc, trade) => acc + trade.shares, 0);
      const tradeNotional = market.trades.reduce((acc, trade) => acc + trade.shares * trade.price, 0);

      out.push({
        marketId: market.id,
        question: market.question,
        closeAt: market.closeAt,
        resolvedOutcome: market.resolvedOutcome,
        yes: { bestBid: yesBids[0]?.price ?? null, bestAsk: yesAsks[0]?.price ?? null },
        no: { bestBid: noBids[0]?.price ?? null, bestAsk: noAsks[0]?.price ?? null },
        tradeCount: market.trades.length,
        tradedShares,
        tradeNotional,
        lastTradePrice: lastTrade?.price ?? null,
      });
    }

    return out;
  }

  private matchOrder(market: MarketState, incoming: LimitOrder, now: number): Trade[] {
    const trades: Trade[] = [];

    while (incoming.remainingShares > 0) {
      const candidate = this.bestMatchCandidate(market, incoming);
      if (!candidate) break;

      assertNoSelfTrade(incoming.agentId, candidate.agentId);

      const shares = Math.min(incoming.remainingShares, candidate.remainingShares);
      const tradePrice = candidate.price;
      const buyerId = incoming.side === "BUY" ? incoming.agentId : candidate.agentId;
      const sellerId = incoming.side === "SELL" ? incoming.agentId : candidate.agentId;

      const buyerAccount = this.mustAccount(buyerId);
      const sellerAccount = this.mustAccount(sellerId);
      const buyerPosition = this.marketPosition(buyerAccount, market.id);

      const currentBuyerExposure = buyerPosition[incoming.outcome].available + buyerPosition[incoming.outcome].locked;
      this.positionGuard.assertNetWithinLimit(currentBuyerExposure + shares);
      this.positionGuard.assertOpenedSharesWithinLimit({
        actorId: buyerId,
        marketId: market.id,
        outcome: incoming.outcome,
        buyShares: shares,
        now,
      });

      this.applyMatchedTrade({
        buyer: buyerAccount,
        seller: sellerAccount,
        marketId: market.id,
        incoming,
        maker: candidate,
        shares,
        price: tradePrice,
      });

      this.positionGuard.recordOpenedShares({
        actorId: buyerId,
        marketId: market.id,
        outcome: incoming.outcome,
        buyShares: shares,
        now,
      });

      incoming.remainingShares -= shares;
      candidate.remainingShares -= shares;

      incoming.status = incoming.remainingShares > 0 ? "PARTIAL" : "FILLED";
      candidate.status = candidate.remainingShares > 0 ? "PARTIAL" : "FILLED";
      incoming.updatedAt = now;
      candidate.updatedAt = now;

      if (candidate.remainingShares === 0) {
        this.removeFromBook(market, candidate);
        this.releaseOrderLock(this.mustAccount(candidate.agentId), candidate);
      }

      const trade: Trade = {
        id: `trd_${++this.tradeSeq}`,
        marketId: market.id,
        outcome: incoming.outcome,
        price: tradePrice,
        shares,
        takerOrderId: incoming.id,
        makerOrderId: candidate.id,
        buyerId,
        sellerId,
        executedAt: now,
      };
      trades.push(trade);
      market.trades.push(trade);
      market.orders.set(candidate.id, { ...candidate });
    }

    return trades;
  }

  private applyMatchedTrade(input: {
    buyer: AgentAccount;
    seller: AgentAccount;
    marketId: string;
    incoming: LimitOrder;
    maker: LimitOrder;
    shares: number;
    price: number;
  }): void {
    const { buyer, seller, marketId, incoming, maker, shares, price } = input;
    const value = shares * price;

    if (incoming.side === "BUY") {
      if (incoming.lockedPoints < value) {
        throw new Error("Incoming buy order has insufficient locked collateral");
      }
      incoming.lockedPoints -= value;
    } else {
      if (maker.lockedPoints < value) {
        throw new Error("Maker buy order has insufficient locked collateral");
      }
      maker.lockedPoints -= value;
    }

    if (incoming.side === "SELL") {
      if (incoming.lockedShares < shares) {
        throw new Error("Incoming sell order has insufficient locked shares");
      }
      incoming.lockedShares -= shares;
    } else {
      if (maker.lockedShares < shares) {
        throw new Error("Maker sell order has insufficient locked shares");
      }
      maker.lockedShares -= shares;
    }

    buyer.lockedPoints -= value;
    seller.availablePoints += value;

    const buyerPosition = this.marketPosition(buyer, marketId);
    const sellerPosition = this.marketPosition(seller, marketId);
    buyerPosition[incoming.outcome].available += shares;
    sellerPosition[incoming.outcome].locked -= shares;
  }

  private lockForOrder(account: AgentAccount, order: LimitOrder): void {
    if (order.side === "BUY") {
      const required = order.price * order.shares;
      if (account.availablePoints < required) {
        throw new Error(`Insufficient points for BUY: need ${required}, have ${account.availablePoints}`);
      }
      account.availablePoints -= required;
      account.lockedPoints += required;
      order.lockedPoints = required;
      return;
    }

    const position = this.marketPosition(account, order.marketId)[order.outcome];
    if (position.available < order.shares) {
      throw new Error(`Insufficient ${order.outcome} shares for SELL`);
    }
    position.available -= order.shares;
    position.locked += order.shares;
    order.lockedShares = order.shares;
  }

  private reconcileLockedAfterPartial(order: LimitOrder, account: AgentAccount): void {
    if (order.side !== "BUY") return;

    const needed = order.remainingShares * order.price;
    if (order.lockedPoints > needed) {
      const release = order.lockedPoints - needed;
      order.lockedPoints -= release;
      account.lockedPoints -= release;
      account.availablePoints += release;
    }
  }

  private releaseOrderLock(account: AgentAccount, order: LimitOrder): void {
    if (order.side === "BUY") {
      if (order.lockedPoints > 0) {
        account.lockedPoints -= order.lockedPoints;
        account.availablePoints += order.lockedPoints;
        order.lockedPoints = 0;
      }
      return;
    }

    if (order.lockedShares > 0) {
      const position = this.marketPosition(account, order.marketId)[order.outcome];
      position.locked -= order.lockedShares;
      position.available += order.lockedShares;
      order.lockedShares = 0;
    }
  }

  private bestMatchCandidate(market: MarketState, incoming: LimitOrder): LimitOrder | null {
    const book = market.books[incoming.outcome];
    const oppositeIds = incoming.side === "BUY" ? book.asks : book.bids;

    for (const id of oppositeIds) {
      const order = market.orders.get(id);
      if (!order) continue;
      const crosses = incoming.side === "BUY" ? incoming.price >= order.price : incoming.price <= order.price;
      if (!crosses) return null;
      return order;
    }

    return null;
  }

  private addToBook(market: MarketState, order: LimitOrder): void {
    const book = market.books[order.outcome];
    const list = order.side === "BUY" ? book.bids : book.asks;

    list.push(order.id);
    list.sort((a, b) => {
      const ao = market.orders.get(a) ?? (a === order.id ? order : undefined);
      const bo = market.orders.get(b) ?? (b === order.id ? order : undefined);
      if (!ao || !bo) return 0;

      if (order.side === "BUY") {
        if (ao.price !== bo.price) return bo.price - ao.price;
      } else if (ao.price !== bo.price) {
        return ao.price - bo.price;
      }

      return ao.createdAt - bo.createdAt;
    });
  }

  private removeFromBook(market: MarketState, order: LimitOrder): void {
    const book = market.books[order.outcome];
    const list = order.side === "BUY" ? book.bids : book.asks;
    const idx = list.indexOf(order.id);
    if (idx >= 0) list.splice(idx, 1);
  }

  private marketPosition(account: AgentAccount, marketId: string): MarketPosition {
    const existing = account.positions[marketId];
    if (existing) return existing;
    account.positions[marketId] = freshPosition();
    return account.positions[marketId];
  }

  private mustMarket(marketId: string): MarketState {
    const market = this.markets.get(marketId);
    if (!market) throw new Error(`Unknown market: ${marketId}`);
    return market;
  }

  private mustAccount(agentId: string): AgentAccount {
    const account = this.accounts.get(agentId);
    if (!account) throw new Error(`Unknown agent: ${agentId}`);
    return account;
  }

  private cloneAccount(account: AgentAccount): AgentAccount {
    const clonedPositions: Record<string, MarketPosition> = {};
    for (const [marketId, position] of Object.entries(account.positions)) {
      clonedPositions[marketId] = {
        YES: { ...position.YES },
        NO: { ...position.NO },
      };
    }

    return {
      agentId: account.agentId,
      availablePoints: account.availablePoints,
      lockedPoints: account.lockedPoints,
      positions: clonedPositions,
    };
  }
}
