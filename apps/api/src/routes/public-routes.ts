import type { FastifyInstance } from "fastify";
import type { ExchangeContract } from "../services/exchange-contract.js";

export async function registerPublicRoutes(app: FastifyInstance, exchange: ExchangeContract): Promise<void> {
  app.get("/public/overview", async () => {
    return { markets: await exchange.publicOverview() };
  });

  app.get("/public/live-activity", async () => {
    return { items: await exchange.publicLiveActivity() };
  });

  app.get("/public/markets/:marketId", async (request) => {
    const params = request.params as { marketId: string };
    return exchange.publicMarketDetail(params.marketId);
  });

  app.get("/public/markets/:marketId/comments", async (request) => {
    const params = request.params as { marketId: string };
    return exchange.publicComments(params.marketId);
  });

  app.get("/public/leaderboard", async () => {
    return { leaderboard: await exchange.publicLeaderboard() };
  });
}
