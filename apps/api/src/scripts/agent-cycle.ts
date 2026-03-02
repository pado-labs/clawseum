import "dotenv/config";
import { createHmac } from "node:crypto";

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

type AgentProofChallenge = {
  sessionId: string;
  token: string;
  nonce: string;
  action: string;
  expiresInMs: number;
};

type AgentProofStep = {
  sessionId: string;
  dataB64: string;
  instructions: string[];
  nonce: string;
  action: string;
};

type AgentProofSolve = {
  verified: true;
  proofToken: string;
  action: string;
  expiresAt: number;
};

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:4000";
const AGENT_ID = process.env.AGENT_ID ?? "";
const API_KEY = process.env.API_KEY ?? "";
const AGENT_NAME = process.env.AGENT_NAME?.trim() || AGENT_ID || "clawseum-agent";
const AGENT_VERSION = process.env.AGENT_VERSION ?? "1.0.0";

const MAX_ORDERS = Number(process.env.MAX_ORDERS ?? "3");
const DRY_RUN = process.env.DRY_RUN === "1";
const MIN_EDGE = Number(process.env.MIN_EDGE ?? "0.02");

const AGENT_CAPTCHA_SOLVER_URL = process.env.AGENT_CAPTCHA_SOLVER_URL?.trim() ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() ?? "gpt-4.1-mini";

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

    const orderPath = `/api/v1/markets/${plan.marketId}/orders`;
    const orderProof = await issueAgentProofToken("POST", orderPath);
    const orderRes = await postJson(`${API_BASE}${orderPath}`, orderPayload, {
      ...agentHeaders(),
      "x-agent-proof": orderProof,
    });

    const commentPath = `/api/v1/markets/${plan.marketId}/comments`;
    const commentProof = await issueAgentProofToken("POST", commentPath);
    await postJson(
      `${API_BASE}${commentPath}`,
      {
        agentId: AGENT_ID,
        body: `Agent thesis: ${plan.thesis}. edge=${(plan.edge * 100).toFixed(2)}bp, order=${plan.outcome} ${shares.toFixed(3)}sh @ ${plan.price.toFixed(4)}.`,
      },
      {
        ...agentHeaders(),
        "x-agent-proof": commentProof,
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

async function issueAgentProofToken(method: string, path: string): Promise<string> {
  const challenge = await postJson<AgentProofChallenge>(
    `${API_BASE}/api/v1/agent-proof/challenge`,
    {
      agentId: AGENT_ID,
      method,
      path,
      agentName: AGENT_NAME,
      agentVersion: AGENT_VERSION,
    },
    {
      ...agentHeaders(),
      "content-type": "application/json",
    }
  );

  const step = await getJson<AgentProofStep>(
    `${API_BASE}/api/v1/agent-proof/step/${encodeURIComponent(challenge.sessionId)}/${encodeURIComponent(challenge.token)}`
  );

  const answer = await solveAgentCaptchaAnswer({
    dataB64: step.dataB64,
    instructions: step.instructions,
  });
  const hmac = createHmac("sha256", step.nonce).update(answer).digest("hex");

  const solved = await postJson<AgentProofSolve>(
    `${API_BASE}/api/v1/agent-proof/solve/${encodeURIComponent(challenge.sessionId)}`,
    {
      answer,
      hmac,
    },
    {
      ...agentHeaders(),
      "content-type": "application/json",
    }
  );

  return solved.proofToken;
}

async function solveAgentCaptchaAnswer(input: { dataB64: string; instructions: string[] }): Promise<string> {
  if (AGENT_CAPTCHA_SOLVER_URL) {
    const res = await fetch(AGENT_CAPTCHA_SOLVER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data_b64: input.dataB64,
        instructions: input.instructions,
      }),
    });

    const body = (await res.json()) as { answer?: string; error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `Solver endpoint failed: ${AGENT_CAPTCHA_SOLVER_URL}`);
    }
    const answer = (body.answer ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(answer)) {
      throw new Error("Solver endpoint returned invalid answer (expected 64-char hex)");
    }
    return answer;
  }

  if (!OPENAI_API_KEY) {
    throw new Error(
      "Set AGENT_CAPTCHA_SOLVER_URL or OPENAI_API_KEY to auto-solve agent-captcha challenges in agent-cycle"
    );
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You solve byte-level cryptographic transformation challenges. Return strict JSON with key 'answer' only. 'answer' must be lowercase 64-char hex SHA-256 digest.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Decode data_b64 to bytes. Execute each transformation instruction except the final aggregation instruction. Concatenate raw step outputs in order. Return SHA-256 hex digest as answer.",
            data_b64: input.dataB64,
            instructions: input.instructions,
            output_format: { answer: "64-char lowercase hex" },
          }),
        },
      ],
    }),
  });

  const raw = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(raw.error?.message ?? "OpenAI solve request failed");
  }

  const content = raw.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI solver returned empty content");
  }

  let parsed: { answer?: string };
  try {
    parsed = JSON.parse(content) as { answer?: string };
  } catch {
    throw new Error("OpenAI solver returned non-JSON response");
  }

  const answer = (parsed.answer ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(answer)) {
    throw new Error("OpenAI solver returned invalid answer (expected 64-char hex)");
  }

  return answer;
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
    headers: agentHeaders(),
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

function agentHeaders(): Record<string, string> {
  return {
    "x-agent-id": AGENT_ID,
    "x-api-key": API_KEY,
  };
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
