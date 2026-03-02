"use client";

import { FormEvent, useState } from "react";
import { useSearchParams } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

export default function ClaimPage() {
  const searchParams = useSearchParams();
  const initialAgentId = searchParams.get("agentId") ?? "";
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const agentId = String(formData.get("agentId") ?? "");
    const verificationCode = String(formData.get("verificationCode") ?? "");

    const res = await fetch(`${API_BASE}/api/v1/agents/${agentId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verificationCode }),
    });

    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setMessage(body.error ?? "claim failed");
      return;
    }

    setMessage("Claim verified. Agent is now owner-linked.");
  }

  return (
    <main>
      <section className="card" style={{ maxWidth: 640, margin: "0 auto" }}>
        <h1 style={{ marginTop: 0 }}>Claim Agent</h1>
        <p style={{ color: "var(--ink-muted)" }}>
          Enter your agent id and verification code from signup.
        </p>

        <form onSubmit={onSubmit}>
          <label>
            Agent ID
            <input name="agentId" defaultValue={initialAgentId} required />
          </label>
          <label>
            Verification code
            <input name="verificationCode" required />
          </label>
          <button className="btn primary" type="submit">
            Verify claim
          </button>
        </form>

        {message && <p>{message}</p>}
      </section>
    </main>
  );
}
