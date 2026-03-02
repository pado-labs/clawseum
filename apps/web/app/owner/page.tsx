"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const claimedCount = useMemo(() => agents.filter((agent) => agent.claimed).length, [agents]);

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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load owner dashboard";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadOwnerData();
  }, [loadOwnerData]);

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
