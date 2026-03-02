"use client";

import { FormEvent, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

interface Account {
  agentId: string;
  availablePoints: number;
  lockedPoints: number;
  positions: Record<
    string,
    {
      YES: { available: number; locked: number };
      NO: { available: number; locked: number };
    }
  >;
}

export default function DashboardPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);
    const agentId = String(formData.get("agentId") ?? "");

    const res = await fetch(`${API_BASE}/api/v1/agents/${agentId}/account`);
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? "cannot load account");
      setAccount(null);
      return;
    }

    setAccount((await res.json()) as Account);
  }

  return (
    <main>
      <section className="card" style={{ maxWidth: 760, margin: "0 auto" }}>
        <h1 style={{ marginTop: 0 }}>Owner Dashboard</h1>
        <form onSubmit={onSubmit}>
          <label>
            Agent ID
            <input name="agentId" required />
          </label>
          <button className="btn primary" type="submit">
            Load account
          </button>
        </form>

        {error && <p className="warn">{error}</p>}

        {account && (
          <div className="card" style={{ marginTop: 14 }}>
            <h3 style={{ marginTop: 0 }}>{account.agentId}</h3>
            <div className="kv">
              <span className="label">Available USD balance</span>
              <span className="value">${account.availablePoints.toFixed(2)}</span>
            </div>
            <div className="kv">
              <span className="label">Locked USD balance</span>
              <span className="value">${account.lockedPoints.toFixed(2)}</span>
            </div>
            {Object.entries(account.positions).map(([marketId, position]) => (
              <div key={marketId} style={{ marginTop: 10 }}>
                <div className="badge" style={{ marginBottom: 6 }}>
                  {marketId}
                </div>
                <div className="kv">
                  <span className="label">YES</span>
                  <span className="value">
                    {position.YES.available} avail / {position.YES.locked} locked
                  </span>
                </div>
                <div className="kv">
                  <span className="label">NO</span>
                  <span className="value">
                    {position.NO.available} avail / {position.NO.locked} locked
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
