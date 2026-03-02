"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getBrowserSupabase } from "../../../lib/supabase-browser";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function completeSignIn() {
      try {
        const supabase = getBrowserSupabase();
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");

        if (code) {
          const { error: codeError } = await supabase.auth.exchangeCodeForSession(code);
          if (codeError) {
            throw codeError;
          }
        }

        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
          throw sessionError;
        }

        if (!data.session) {
          throw new Error("No active session found after login");
        }

        if (!cancelled) {
          router.replace("/owner");
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to complete sign-in";
          setError(message);
        }
      }
    }

    completeSignIn();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="app-shell" style={{ maxWidth: 760, margin: "0 auto", paddingTop: 42 }}>
      <section className="card-surface">
        <h2 style={{ marginTop: 0 }}>Completing login...</h2>
        {error ? <p className="warn">{error}</p> : <p className="muted">Please wait while we verify your magic link.</p>}
      </section>
    </main>
  );
}
