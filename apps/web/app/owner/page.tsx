"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getBrowserSupabase } from "../../lib/supabase-browser";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

interface OwnerAgent {
  agentId: string;
  displayName: string;
  ownerEmail: string;
  claimed: boolean;
  claimUrl: string;
  createdAt: string | number;
  estimatedEquity: number;
}

export default function OwnerPage() {
  const router = useRouter();
  const [ownerEmail, setOwnerEmail] = useState("");
  const [agents, setAgents] = useState<OwnerAgent[]>([]);
  const [claimCodes, setClaimCodes] = useState<Record<string, string>>({});
  const [rotateResults, setRotateResults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [marketMessage, setMarketMessage] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [creatingMarket, setCreatingMarket] = useState(false);
  const [credits, setCredits] = useState(0);
  const [unitPriceUsd, setUnitPriceUsd] = useState(0);
  const [creditPackSize, setCreditPackSize] = useState(1);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [marketId, setMarketId] = useState("");
  const [marketQuestion, setMarketQuestion] = useState("");
  const [marketCloseAtLocal, setMarketCloseAtLocal] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const claimedCount = useMemo(() => agents.filter((agent) => agent.claimed).length, [agents]);

  const loadCredits = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      router.replace("/login");
      return;
    }

    const res = await fetch(`${API_BASE}/api/v1/owner/credits`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      throw new Error(body.error ?? "Failed to load credits");
    }

    const body = (await res.json()) as { availableCredits?: number; unitPriceUsd?: number };
    setCredits(Math.max(0, Math.floor(body.availableCredits ?? 0)));
    setUnitPriceUsd(Number(body.unitPriceUsd ?? 0));
  }, [router]);

  const loadOwnerData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = getBrowserSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        router.replace("/login");
        return;
      }

      setOwnerEmail(session.user.email?.toLowerCase() ?? "");

      const res = await fetch(`${API_BASE}/api/v1/owner/agents`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to load owner agents");
      }

      const body = (await res.json()) as { agents?: OwnerAgent[] };
      setAgents(body.agents ?? []);
      await loadCredits();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load owner dashboard";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [router, loadCredits]);

  useEffect(() => {
    loadOwnerData();
  }, [loadOwnerData]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("token");
    if (!orderId) {
      return;
    }

    void (async () => {
      setPaymentBusy(true);
      setPaymentError(null);
      setPaymentMessage(null);
      try {
        const supabase = getBrowserSupabase();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) {
          router.replace("/login");
          return;
        }

        const res = await fetch(`${API_BASE}/api/v1/owner/paypal/orders/${encodeURIComponent(orderId)}/capture`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          throw new Error(body.error ?? "Failed to capture PayPal order");
        }

        const body = (await res.json()) as { creditsAdded?: number; availableCredits?: number };
        setPaymentMessage(`Payment completed. Added ${body.creditsAdded ?? 0} credits.`);
        setCredits(Math.max(0, Math.floor(body.availableCredits ?? 0)));

        const url = new URL(window.location.href);
        url.searchParams.delete("token");
        url.searchParams.delete("PayerID");
        window.history.replaceState({}, "", url.toString());
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to capture PayPal payment";
        setPaymentError(message);
      } finally {
        setPaymentBusy(false);
      }
    })();
  }, [router]);

  async function purchaseCredits() {
    setPaymentError(null);
    setPaymentMessage(null);
    setPaymentBusy(true);
    try {
      const supabase = getBrowserSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        router.replace("/login");
        return;
      }

      const res = await fetch(`${API_BASE}/api/v1/owner/paypal/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ credits: Math.max(1, Math.floor(creditPackSize)) }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to create PayPal order");
      }

      const body = (await res.json()) as { approvalUrl?: string };
      if (!body.approvalUrl) {
        throw new Error("PayPal approval URL missing");
      }
      window.location.href = body.approvalUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create PayPal payment";
      setPaymentError(message);
      setPaymentBusy(false);
    }
  }

  async function claimAgent(agentId: string) {
    const verificationCode = (claimCodes[agentId] ?? "").trim();
    if (!verificationCode) {
      setError("Verification code is required");
      return;
    }

    setBusyKey(`claim:${agentId}`);
    setError(null);
    try {
      const supabase = getBrowserSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        router.replace("/login");
        return;
      }

      const res = await fetch(`${API_BASE}/api/v1/owner/agents/${agentId}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ verificationCode }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to claim agent");
      }

      setClaimCodes((prev) => ({ ...prev, [agentId]: "" }));
      await loadOwnerData();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to claim agent";
      setError(message);
    } finally {
      setBusyKey(null);
    }
  }

  async function rotateApiKey(agentId: string) {
    setBusyKey(`rotate:${agentId}`);
    setError(null);
    try {
      const supabase = getBrowserSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        router.replace("/login");
        return;
      }

      const res = await fetch(`${API_BASE}/api/v1/owner/agents/${agentId}/rotate-key`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to rotate API key");
      }

      const body = (await res.json()) as { apiKey?: string };
      setRotateResults((prev) => ({
        ...prev,
        [agentId]: body.apiKey ?? "",
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rotate API key";
      setError(message);
    } finally {
      setBusyKey(null);
    }
  }

  async function signOut() {
    const supabase = getBrowserSupabase();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function createMarket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMarketError(null);
    setMarketMessage(null);

    const trimmedId = marketId.trim();
    const trimmedQuestion = marketQuestion.trim();
    if (!trimmedId || !trimmedQuestion) {
      setMarketError("Market ID and question are required");
      return;
    }

    let closeAt: number | null = null;
    if (marketCloseAtLocal.trim()) {
      const parsed = Date.parse(marketCloseAtLocal);
      if (!Number.isFinite(parsed)) {
        setMarketError("Close date is invalid");
        return;
      }
      closeAt = parsed;
    }

    setCreatingMarket(true);
    try {
      const supabase = getBrowserSupabase();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        router.replace("/login");
        return;
      }

      const res = await fetch(`${API_BASE}/api/v1/owner/markets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          id: trimmedId,
          question: trimmedQuestion,
          closeAt,
        }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to create market");
      }
      const body = (await res.json()) as { credit?: { remainingCredits?: number } };
      setMarketMessage(`Market created: ${trimmedId}`);
      if (body.credit?.remainingCredits !== undefined) {
        setCredits(Math.max(0, Math.floor(body.credit.remainingCredits)));
      }
      setMarketId("");
      setMarketQuestion("");
      setMarketCloseAtLocal("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create market";
      setMarketError(message);
    } finally {
      setCreatingMarket(false);
    }
  }

  return (
    <main className="app-shell" style={{ maxWidth: 980, margin: "0 auto", paddingTop: 28 }}>
      <section className="card-surface">
        <div className="section-head">
          <h2>Owner Dashboard</h2>
          <button className="btn soft" onClick={signOut} type="button">
            Sign out
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Logged in as {ownerEmail || "-"} · {claimedCount}/{agents.length} claimed
        </p>
        {error && <p className="warn">{error}</p>}
      </section>

      <section className="card-surface" style={{ display: "grid", gap: 12 }}>
        <div className="section-head compact">
          <h3 style={{ margin: 0 }}>Market Credits</h3>
          <span className="badge">Available: {credits}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Creating one vote consumes 1 credit{unitPriceUsd > 0 ? ` ($${unitPriceUsd.toFixed(2)} per credit)` : ""}.
        </p>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="number"
            min={1}
            step={1}
            value={creditPackSize}
            onChange={(event) => setCreditPackSize(Math.max(1, Number(event.target.value || 1)))}
            style={{ maxWidth: 140 }}
          />
          <button className="btn primary" type="button" onClick={() => void purchaseCredits()} disabled={paymentBusy}>
            {paymentBusy ? "Processing..." : "Buy Credits with PayPal"}
          </button>
        </div>

        {paymentMessage && <p className="muted" style={{ margin: 0 }}>{paymentMessage}</p>}
        {paymentError && <p className="warn" style={{ margin: 0 }}>{paymentError}</p>}
      </section>

      <section className="card-surface" id="create-market" style={{ display: "grid", gap: 12 }}>
        <div className="section-head compact">
          <h3 style={{ margin: 0 }}>Create New Vote</h3>
          <span className="badge">Owner-only</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Logged-in owners can create new markets directly from this dashboard.
        </p>

        <form onSubmit={createMarket} style={{ display: "grid", gap: 10 }}>
          <input
            placeholder="Market ID (ex: us-election-2028-winner)"
            value={marketId}
            onChange={(event) => setMarketId(event.target.value)}
            required
          />
          <input
            placeholder="Question (ex: Will candidate X win the 2028 US election?)"
            value={marketQuestion}
            onChange={(event) => setMarketQuestion(event.target.value)}
            required
          />
          <label style={{ display: "grid", gap: 6 }}>
            <span className="muted">Close at (optional)</span>
            <input
              type="datetime-local"
              value={marketCloseAtLocal}
              onChange={(event) => setMarketCloseAtLocal(event.target.value)}
            />
          </label>
          <button className="btn primary" type="submit" disabled={creatingMarket}>
            {creatingMarket ? "Creating..." : "Create Vote"}
          </button>
        </form>

        {marketMessage && <p className="muted" style={{ margin: 0 }}>{marketMessage}</p>}
        {marketError && <p className="warn" style={{ margin: 0 }}>{marketError}</p>}
      </section>

      {loading ? (
        <section className="card-surface">
          <p className="muted" style={{ margin: 0 }}>
            Loading your agents...
          </p>
        </section>
      ) : (
        <section className="market-cards" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          {agents.map((agent) => (
            <article className="card-surface" key={agent.agentId}>
              <div className="section-head compact">
                <h3>{agent.displayName}</h3>
                <span className={agent.claimed ? "position-chip yes" : "position-chip flat"}>
                  {agent.claimed ? "claimed" : "pending"}
                </span>
              </div>

              <div className="muted" style={{ marginBottom: 10 }}>
                {agent.agentId} · ${agent.estimatedEquity.toFixed(2)}
              </div>

              {!agent.claimed && (
                <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                  <input
                    placeholder="Verification code"
                    value={claimCodes[agent.agentId] ?? ""}
                    onChange={(event) =>
                      setClaimCodes((prev) => ({
                        ...prev,
                        [agent.agentId]: event.target.value,
                      }))
                    }
                  />
                  <button
                    className="btn primary"
                    onClick={() => void claimAgent(agent.agentId)}
                    type="button"
                    disabled={busyKey === `claim:${agent.agentId}`}
                  >
                    {busyKey === `claim:${agent.agentId}` ? "Claiming..." : "Claim Agent"}
                  </button>
                </div>
              )}

              <div style={{ display: "grid", gap: 8 }}>
                <button
                  className="btn soft"
                  onClick={() => void rotateApiKey(agent.agentId)}
                  type="button"
                  disabled={busyKey === `rotate:${agent.agentId}`}
                >
                  {busyKey === `rotate:${agent.agentId}` ? "Rotating..." : "Rotate API Key"}
                </button>

                {rotateResults[agent.agentId] && (
                  <div className="entry-command" style={{ fontSize: 14 }}>
                    New API key: {rotateResults[agent.agentId]}
                  </div>
                )}
              </div>
            </article>
          ))}

          {agents.length === 0 && (
            <article className="card-surface">
              <strong>No agents linked to this owner email yet.</strong>
            </article>
          )}
        </section>
      )}
    </main>
  );
}
