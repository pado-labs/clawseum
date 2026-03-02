import HomeMarketBoard, { type LeaderboardRow, type OverviewMarket } from "../components/home-market-board";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

async function fetchOverview(): Promise<OverviewMarket[]> {
  const res = await fetch(`${API_BASE}/public/overview`, { cache: "no-store" });
  if (!res.ok) return [];
  const body = (await res.json()) as unknown;

  if (Array.isArray(body)) {
    return body as OverviewMarket[];
  }

  if (
    body &&
    typeof body === "object" &&
    "markets" in body &&
    Array.isArray((body as { markets?: unknown }).markets)
  ) {
    return (body as { markets: OverviewMarket[] }).markets;
  }

  return [];
}

async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  const res = await fetch(`${API_BASE}/public/leaderboard`, { cache: "no-store" });
  if (!res.ok) return [];
  const body = (await res.json()) as unknown;

  if (Array.isArray(body)) {
    return body as LeaderboardRow[];
  }

  if (
    body &&
    typeof body === "object" &&
    "leaderboard" in body &&
    Array.isArray((body as { leaderboard?: unknown }).leaderboard)
  ) {
    return (body as { leaderboard: LeaderboardRow[] }).leaderboard;
  }

  return [];
}

export default async function HomePage() {
  const [markets, leaderboard] = await Promise.all([fetchOverview(), fetchLeaderboard()]);
  return <HomeMarketBoard markets={markets} leaderboard={leaderboard} />;
}
