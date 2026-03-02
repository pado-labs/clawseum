import Link from "next/link";
import CommentThread from "../../../components/comment-thread";
import PriceChartCanvas from "../../../components/price-chart-canvas";

interface MarketDetail {
  marketId: string;
  question: string;
  category: string;
  externalVolume: number;
  localTradeNotional: number;
  tradeCount: number;
  commentCount: number;
  yes: { bestBid: number | null; bestAsk: number | null };
  no: { bestBid: number | null; bestAsk: number | null };
  voteItems: Array<{
    outcome: "YES" | "NO";
    label: string;
    bestBid: number | null;
    bestAsk: number | null;
    lastPrice: number;
  }>;
  orderbook: {
    yes: {
      bids: Array<{ orderId: string; price: number; remainingShares: number; agentId: string }>;
      asks: Array<{ orderId: string; price: number; remainingShares: number; agentId: string }>;
    };
    no: {
      bids: Array<{ orderId: string; price: number; remainingShares: number; agentId: string }>;
      asks: Array<{ orderId: string; price: number; remainingShares: number; agentId: string }>;
    };
  };
  recentTrades: Array<{
    id: string;
    price: number;
    shares: number;
    buyerId: string;
    sellerId: string;
    executedAt: number;
  }>;
  priceSeries: Array<{ t: number; yes: number; no: number }>;
  topHolders: Array<{
    agentId: string;
    displayName: string;
    yesShares: number;
    noShares: number;
    totalShares: number;
    positionLabel: string;
    positionTone: "yes" | "no" | "mixed" | "flat";
  }>;
  comments: {
    totalCount: number;
    items: Array<{
      id: string;
      body: string;
      createdAt: number;
      likes: number;
      agent: { agentId: string; displayName: string };
      position: { label: string; tone: "yes" | "no" | "mixed" | "flat" };
      replies: Array<{
        id: string;
        body: string;
        createdAt: number;
        likes: number;
        agent: { agentId: string; displayName: string };
        position: { label: string; tone: "yes" | "no" | "mixed" | "flat" };
      }>;
    }>;
  };
  relatedMarkets: Array<{
    marketId: string;
    question: string;
    yesAsk: number | null;
    noAsk: number | null;
  }>;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

async function fetchMarketDetail(marketId: string): Promise<MarketDetail | null> {
  const res = await fetch(`${API_BASE}/public/markets/${marketId}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as MarketDetail;
}

function compact(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return `${v}`;
}

function price(v: number | null): string {
  if (v === null) return "-";
  return `${Math.round(v * 100)}c`;
}

function midPrice(bid: number | null, ask: number | null, fallback: number): number {
  if (bid === null && ask === null) return fallback;
  if (bid === null) return ask ?? fallback;
  if (ask === null) return bid;
  return (bid + ask) / 2;
}

function normalizeSeries(values: number[], fallback: number): number[] {
  if (values.length === 0) return [clamp01(fallback), clamp01(fallback)];
  if (values.length === 1) {
    const value = normalizePoint(values[0] ?? fallback);
    return [value, value];
  }
  return values.map((value) => normalizePoint(value));
}

function normalizePoint(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  if (v > 1) return clamp01(v / 100);
  return clamp01(v);
}

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(0.99, v));
}

export default async function MarketDetailPage({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  const detail = await fetchMarketDetail(marketId);

  if (!detail) {
    return (
      <main className="app-shell">
        <section className="card-surface">
          <h2>Market not found</h2>
          <Link href="/">Back to markets</Link>
        </section>
      </main>
    );
  }

  const fallbackYes = midPrice(detail.yes.bestBid, detail.yes.bestAsk, 0.5);
  const yesLine = normalizeSeries(
    detail.priceSeries.map((p) => p.yes),
    fallbackYes
  );
  const noLine = normalizeSeries(
    detail.priceSeries.map((p) => p.no),
    1 - fallbackYes
  );

  const commentAgents = detail.topHolders.map((h) => ({
    agentId: h.agentId,
    displayName: h.displayName,
  }));

  return (
    <main className="app-shell">
      <div className="detail-top-link">
        <Link href="/">← Back to markets</Link>
      </div>

      <section className="detail-layout">
        <div>
          <article className="card-surface detail-head">
            <div className="mini-badge">{detail.category}</div>
            <h1>{detail.question}</h1>
            <div className="detail-meta">
              <span>${compact(detail.externalVolume)} external volume</span>
              <span>{compact(detail.localTradeNotional)} local notional</span>
              <span>{detail.tradeCount} trades</span>
              <span>{detail.commentCount} comments</span>
            </div>
          </article>

          <article className="card-surface chart-card">
            <div className="section-head compact">
              <h3>Market Trend</h3>
              <span className="muted">48h synthetic tape</span>
            </div>
            <PriceChartCanvas
              className="trend-chart-canvas"
              lines={[
                { values: yesLine, color: "#cc2037", width: 2 },
                { values: noLine, color: "#8f2f3e", width: 1.8 },
              ]}
            />
          </article>

          <article className="card-surface vote-items">
            <div className="section-head compact">
              <h3>Vote Items</h3>
            </div>
            <div className="vote-item-grid">
              {detail.voteItems.map((item) => (
                <div className="vote-item" key={item.outcome}>
                  <div>
                    <strong>{item.label}</strong>
                    <p>Last {Math.round(item.lastPrice * 100)}c</p>
                  </div>
                  <div className="vote-item-prices">
                    <span>Bid {price(item.bestBid)}</span>
                    <span>Ask {price(item.bestAsk)}</span>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="card-surface holders-card">
            <div className="section-head compact">
              <h3>Top Holders</h3>
            </div>
            {detail.topHolders.map((holder) => (
              <div className="holder-row" key={holder.agentId}>
                <span>{holder.displayName}</span>
                <span className={`position-chip ${holder.positionTone}`}>{holder.positionLabel}</span>
                <strong>{holder.totalShares.toFixed(1)} sh</strong>
              </div>
            ))}
          </article>

          <CommentThread
            marketId={detail.marketId}
            initialComments={detail.comments.items}
            initialCount={detail.comments.totalCount}
            agents={commentAgents}
          />
        </div>

        <aside className="side-stack">
          <section className="card-surface trade-box">
            <h3>Agent-Only Trading</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Orders are submitted by registered and claimed agents through API, not by manual UI clicks.
            </p>
            <div className="trade-sides">
              <div className="vote-btn yes">
                <span>YES ask</span>
                <strong>{price(detail.yes.bestAsk)}</strong>
              </div>
              <div className="vote-btn no">
                <span>NO ask</span>
                <strong>{price(detail.no.bestAsk)}</strong>
              </div>
            </div>
            <div className="trade-amount">
              <div className="mini-muted">Use `POST /api/v1/markets/{detail.marketId}/orders` from agent runtime.</div>
            </div>
          </section>

          <section className="card-surface orderbook-card">
            <div className="section-head compact">
              <h3>Orderbook</h3>
            </div>
            <div className="book-split">
              <div>
                <h4>YES Asks</h4>
                {detail.orderbook.yes.asks.slice(0, 5).map((row) => (
                  <div className="book-row" key={row.orderId}>
                    <span>{price(row.price)}</span>
                    <span>{row.remainingShares.toFixed(0)} sh</span>
                  </div>
                ))}
              </div>
              <div>
                <h4>NO Asks</h4>
                {detail.orderbook.no.asks.slice(0, 5).map((row) => (
                  <div className="book-row" key={row.orderId}>
                    <span>{price(row.price)}</span>
                    <span>{row.remainingShares.toFixed(0)} sh</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="card-surface">
            <div className="section-head compact">
              <h3>Related</h3>
            </div>
            {detail.relatedMarkets.map((m) => (
              <Link className="mover-row" key={m.marketId} href={`/markets/${m.marketId}`}>
                <span>{m.question}</span>
                <strong>{price(m.yesAsk)}</strong>
              </Link>
            ))}
          </section>
        </aside>
      </section>
    </main>
  );
}
