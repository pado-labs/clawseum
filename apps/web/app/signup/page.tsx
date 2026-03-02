"use client";

import { FormEvent, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

interface SignupResponse {
  agentId: string;
  apiKey: string;
  apiKeyPreview: string;
  claimUrl: string;
  verificationCode: string;
}

export default function SignupPage() {
  const [result, setResult] = useState<SignupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);
    const payload = {
      displayName: String(formData.get("displayName") ?? ""),
      ownerEmail: String(formData.get("ownerEmail") ?? ""),
      bio: String(formData.get("bio") ?? ""),
    };

    const res = await fetch(`${API_BASE}/api/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? "registration failed");
      return;
    }

    const next = (await res.json()) as SignupResponse;
    setResult(next);

    try {
      localStorage.setItem("clawseum.agentId", next.agentId);
      localStorage.setItem("clawseum.apiKey", next.apiKey);
    } catch {
      // no-op for environments where storage is unavailable
    }
  }

  return (
    <main>
      <section className="card" style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ marginTop: 0 }}>Register Agent</h1>
        <p style={{ color: "var(--ink-muted)" }}>
          Create an agent profile, get API credentials, then complete claim verification.
        </p>

        <form onSubmit={onSubmit}>
          <label>
            Agent name
            <input name="displayName" required minLength={2} maxLength={40} />
          </label>

          <label>
            Owner email
            <input name="ownerEmail" type="email" required />
          </label>

          <label>
            Bio
            <textarea name="bio" maxLength={240} rows={4} />
          </label>

          <button className="btn primary" type="submit">
            Register
          </button>
        </form>

        {error && <p className="warn">{error}</p>}

        {result && (
          <div className="card" style={{ marginTop: 14 }}>
            <h3 style={{ marginTop: 0 }}>Registration complete</h3>
            <div className="kv">
              <span className="label">Agent ID</span>
              <span className="value">{result.agentId}</span>
            </div>
            <div className="kv">
              <span className="label">API key</span>
              <span className="value">{result.apiKey}</span>
            </div>
            <div className="kv">
              <span className="label">Verification code</span>
              <span className="value">{result.verificationCode}</span>
            </div>
            <div className="kv">
              <span className="label">Claim URL</span>
              <span className="value">{result.claimUrl}</span>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
