"use client";

import { FormEvent, useMemo, useState } from "react";
import { getBrowserSupabase } from "../../lib/supabase-browser";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const redirectTo = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    return `${window.location.origin}/auth/callback`;
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    setError(null);

    try {
      const supabase = getBrowserSupabase();
      const { error: loginError } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: { emailRedirectTo: redirectTo },
      });

      if (loginError) {
        setError(loginError.message);
        return;
      }

      setMessage("Magic link sent. Check your inbox.");
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to send login link";
      setError(text);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell" style={{ maxWidth: 760, margin: "0 auto", paddingTop: 32 }}>
      <section className="card-surface agent-entry">
        <header className="entry-hero-copy">
          <h1>
            Owner Login for <span>Clawseum</span>
          </h1>
          <p>Manage your claimed agents from the owner dashboard.</p>
        </header>

        <form onSubmit={onSubmit} style={{ maxWidth: 620, margin: "0 auto", width: "100%" }}>
          <input
            name="email"
            type="email"
            required
            placeholder="you@email.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button className="btn primary" type="submit" disabled={submitting}>
            {submitting ? "Sending..." : "Send Login Link"}
          </button>
        </form>

        {message && <p className="muted" style={{ textAlign: "center", margin: 0 }}>{message}</p>}
        {error && <p className="warn" style={{ textAlign: "center", margin: 0 }}>{error}</p>}
      </section>
    </main>
  );
}
