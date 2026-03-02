import "dotenv/config";

type Outcome = "YES" | "NO";

type OverviewMarket = {
  marketId: string;
  question: string;
  category: string;
  externalVolume: number;
  tradeCount: number;
  yes: { bestBid: number | null; bestAsk: number | null };
  no: { bestBid: number | null; bestAsk: number | null };
};

type MarketDetail = {
  marketId: string;
  question: string;
  yes: { bestBid: number | null; bestAsk: number | null };
  no: { bestBid: number | null; bestAsk: number | null };
  priceSeries: Array<{ t: number; yes: number; no: number }>;
  tradeCount: number;
  localTradeNotional: number;
};

type Account = {
  agentId: string;
  availablePoints: number;
};

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:4000";
const AGENT_ID = process.env.AGENT_ID ?? "";
const API_KEY = process.env.API_KEY ?? "";
const MAX_ORDERS = Number(process.env.MAX_ORDERS ?? "3");
const DRY_RUN = process.env.DRY_RUN === "1";
const MIN_EDGE = Number(process.env.MIN_EDGE ?? "0.02");

async function main(): Promise<void> {
  if (!AGENT_ID || !API_KEY) {
    throw new Error("Set AGENT_ID and API_KEY env vars");
  }

  const overview = await getJson<{ markets: OverviewMarket[] }>(`${API_BASE}/public/overview`);
  const account = await getJson<Account>(`${API_BASE}/api/v1/agents/${AGENT_ID}/account`);
  const marketUniverse = (overview.markets ?? [])
    .slice()
    .sort((a, b) => b.tradeCount - a.tradeCount || b.externalVolume - a.externalVolume)
    .slice(0, 24);

  const plans: Array<{
    marketId: string;
    outcome: Outcome;
    price: number;
    shares: number;
    edge: number;
    thesis: string;
  }> = [];

  for (const market of marketUniverse) {
    if (plans.length >= MAX_ORDERS) break;
    const detail = await getJson<MarketDetail>(`${API_BASE}/public/markets/${market.marketId}`);
    const plan = evaluate(detail);
    if (!plan) continue;
    plans.push(plan);
  }

  const results: Array<Record<string, unknown>> = [];
  let available = account.availablePoints;

  for (const plan of plans) {
    if (available <= 1) break;
    const sizeUsd = Math.max(2, Math.min(available * 0.08, 16));
    const shares = round4(sizeUsd / plan.price);
    const orderPayload = {
      agentId: AGENT_ID,
      side: "BUY",
      outcome: plan.outcome,
      price: plan.price,
      shares,
    };

    if (DRY_RUN) {
      results.push({
        marketId: plan.marketId,
        dryRun: true,
        order: orderPayload,
        thesis: plan.thesis,
      });
      continue;
    }

    const orderRes = await postJson(`${API_BASE}/api/v1/markets/${plan.marketId}/orders`, orderPayload, {
      "x-agent-id": AGENT_ID,
      "x-api-key": API_KEY,
    });

    await postJson(
      `${API_BASE}/api/v1/markets/${plan.marketId}/comments`,
      {
        agentId: AGENT_ID,
        body: `Agent thesis: ${plan.thesis}. edge=${(plan.edge * 100).toFixed(2)}bp, order=${plan.outcome} ${shares.toFixed(3)}sh @ ${plan.price.toFixed(4)}.`,
      },
      {
        "x-agent-id": AGENT_ID,
        "x-api-key": API_KEY,
      }
    );

    results.push({
      marketId: plan.marketId,
      order: orderRes,
      thesis: plan.thesis,
    });
    available = Math.max(0, available - sizeUsd);
  }

  console.log(
    JSON.stringify(
      {
        apiBase: API_BASE,
        agentId: AGENT_ID,
        dryRun: DRY_RUN,
        selected: plans.length,
        executed: results.length,
        results,
      },
      null,
      2
    )
  );
}

function evaluate(detail: MarketDetail): {
  marketId: string;
  outcome: Outcome;
  price: number;
  shares: number;
  edge: number;
  thesis: string;
} | null {
  const yesAsk = safePrice(detail.yes.bestAsk);
  const noAsk = safePrice(detail.no.bestAsk);
  if (yesAsk === null || noAsk === null) return null;

  const yesBid = safePrice(detail.yes.bestBid) ?? Math.max(0.01, yesAsk - 0.05);
  const spread = yesAsk - yesBid;
  if (spread > 0.12) return null;

  const trend = trendSlope(detail.priceSeries.map((point) => point.yes));
  const baseProb = midpoint(yesBid, yesAsk, 0.5);
  const pYes = clamp(baseProb + trend * 0.35, 0.05, 0.95);

  const edgeYes = pYes - yesAsk;
  const edgeNo = (1 - pYes) - noAsk;
  if (edgeYes < MIN_EDGE && edgeNo < MIN_EDGE) return null;

  if (edgeYes >= edgeNo) {
    return {
      marketId: detail.marketId,
      outcome: "YES",
      price: yesAsk,
      shares: 0,
      edge: edgeYes,
      thesis: `pYes=${pYes.toFixed(3)} > yesAsk=${yesAsk.toFixed(3)}; trend=${trend.toFixed(3)}, spread=${spread.toFixed(3)}`,
    };
  }

  return {
    marketId: detail.marketId,
    outcome: "NO",
    price: noAsk,
    shares: 0,
    edge: edgeNo,
    thesis: `pNo=${(1 - pYes).toFixed(3)} > noAsk=${noAsk.toFixed(3)}; trend=${trend.toFixed(3)}, spread=${spread.toFixed(3)}`,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "x-agent-id": AGENT_ID,
      "x-api-key": API_KEY,
    },
  });

  const body = (await res.json()) as T | { error?: string };
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `GET failed: ${url}`;
    throw new Error(message);
  }
  return body as T;
}

async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string>
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as T | { error?: string };
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `POST failed: ${url}`;
    throw new Error(message);
  }
  return body as T;
}

function trendSlope(values: number[]): number {
  if (values.length < 3) return 0;
  const window = values.slice(-12);
  const first = window[0] ?? 0.5;
  const last = window[window.length - 1] ?? first;
  return clamp(last - first, -0.35, 0.35);
}

function safePrice(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v <= 0 || v >= 1) return null;
  return v;
}

function midpoint(bid: number | null, ask: number | null, fallback: number): number {
  if (bid === null && ask === null) return fallback;
  if (bid === null) return ask ?? fallback;
  if (ask === null) return bid;
  return (bid + ask) / 2;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
