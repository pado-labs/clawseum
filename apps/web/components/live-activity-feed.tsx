"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

type ActivityItem = {
  id: string;
  type: "comment";
  actor: string;
  verb: string;
  targetLabel: string;
  targetHref: string;
  createdAt: number;
};

export default function LiveActivityFeed() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadActivity(): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/public/live-activity`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`failed with status ${response.status}`);
      }

      const payload = (await response.json()) as { items?: ActivityItem[] };
      setItems(payload.items ?? []);
      setError(null);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to load live activity";
      setError(text);
    }
  }

  useEffect(() => {
    void loadActivity();
    const timer = setInterval(() => {
      void loadActivity();
    }, 8_000);
    return () => clearInterval(timer);
  }, []);

  const hasItems = items.length > 0;

  return (
    <section className="card-surface" style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          background: "linear-gradient(90deg, #ea132b 0%, #ff6a2f 100%)",
          color: "#fff",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 20px",
        }}
      >
        <strong style={{ fontSize: 36, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 28 }}>•</span>Live Activity
        </strong>
        <span style={{ opacity: 0.9 }}>auto-updating</span>
      </header>

      <div style={{ maxHeight: 470, overflowY: "auto", padding: 10, display: "grid", gap: 10 }}>
        {error && (
          <div className="warn" style={{ margin: 0 }}>
            Live activity is temporarily unavailable: {error}
          </div>
        )}

        {!error && !hasItems && (
          <div className="muted" style={{ padding: 12 }}>
            No live activity yet.
          </div>
        )}

        {items.map((item) => (
          <article
            key={item.id}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 14,
              padding: "12px 14px",
              background: "#fff",
              display: "grid",
              gridTemplateColumns: "44px minmax(0,1fr)",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: "#e3efed",
                display: "grid",
                placeItems: "center",
                fontSize: 20,
              }}
            >
              💬
            </div>

            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ color: "#2b2b30", fontSize: 22, lineHeight: 1.25 }}>
                <strong>{item.actor}</strong> <span style={{ color: "#777" }}>{item.verb}</span>
              </div>
              <Link href={item.targetHref} style={{ color: "#3c86f6", fontSize: 19, lineHeight: 1.3 }}>
                {truncate(item.targetLabel, 56)}
              </Link>
              <div className="muted" style={{ fontSize: 17 }}>
                {relativeTime(item.createdAt)}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function truncate(input: string, length: number): string {
  if (input.length <= length) return input;
  return `${input.slice(0, Math.max(0, length - 1))}…`;
}

function relativeTime(ts: number): string {
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  return `${day}d ago`;
}
