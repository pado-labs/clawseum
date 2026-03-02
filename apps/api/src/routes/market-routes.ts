import type { FastifyInstance } from "fastify";
import type { Outcome } from "@clawseum/shared-types";
import type { ExchangeContract } from "../services/exchange-contract.js";
import type { AgentProofService } from "../services/agent-proof.js";
import { requireAgentAccess } from "./agent-auth.js";

export async function registerMarketRoutes(
  app: FastifyInstance,
  exchange: ExchangeContract,
  proof: AgentProofService
): Promise<void> {
  app.post("/api/v1/markets", async (request) => {
    const body = request.body as { id: string; question: string; closeAt?: number | null };
    return exchange.createMarket(body);
  });

  app.post("/api/v1/markets/:marketId/mint", async (request) => {
    const params = request.params as { marketId: string };
    const body = request.body as { agentId: string; shares: number };
    await requireAgentAccess(request, exchange, body.agentId, {
      proofService: proof,
      requireProof: true,
    });
    return exchange.mintCompleteSet({ ...body, marketId: params.marketId });
  });

  app.post("/api/v1/markets/:marketId/orders", async (request) => {
    const params = request.params as { marketId: string };
    const body = request.body as {
      agentId: string;
      side: "BUY" | "SELL";
      outcome: Outcome;
      price: number;
      shares: number;
    };
    await requireAgentAccess(request, exchange, body.agentId, {
      proofService: proof,
      requireProof: true,
    });
    return exchange.placeOrder({ ...body, marketId: params.marketId });
  });

  app.post("/api/v1/markets/:marketId/orders/:orderId/cancel", async (request) => {
    const params = request.params as { marketId: string; orderId: string };
    const body = request.body as { agentId: string };
    await requireAgentAccess(request, exchange, body.agentId, {
      proofService: proof,
      requireProof: true,
    });
    return exchange.cancelOrder({ ...params, agentId: body.agentId });
  });

  app.get("/api/v1/markets/:marketId/book", async (request) => {
    const params = request.params as { marketId: string };
    const query = request.query as { outcome?: Outcome; depth?: number };

    return exchange.book({
      marketId: params.marketId,
      outcome: query.outcome ?? "YES",
      depth: query.depth,
    });
  });

  app.post("/api/v1/markets/:marketId/resolve", async (request) => {
    const params = request.params as { marketId: string };
    const body = request.body as { outcome: Outcome };
    return exchange.resolveMarket({ marketId: params.marketId, outcome: body.outcome });
  });

  app.post("/api/v1/markets/:marketId/redeem", async (request) => {
    const params = request.params as { marketId: string };
    const body = request.body as { agentId: string };
    await requireAgentAccess(request, exchange, body.agentId, {
      proofService: proof,
      requireProof: true,
    });
    return exchange.redeem({ marketId: params.marketId, agentId: body.agentId });
  });

  app.post(
    "/api/v1/markets/:marketId/comments",
    {
      schema: {
        body: {
          type: "object",
          required: ["agentId", "body"],
          properties: {
            agentId: { type: "string", minLength: 2, maxLength: 80 },
            body: { type: "string", minLength: 2, maxLength: 500 },
            parentId: { type: ["string", "null"] },
          },
        },
      },
    },
    async (request) => {
      const params = request.params as { marketId: string };
      const body = request.body as { agentId: string; body: string; parentId?: string | null };
      await requireAgentAccess(request, exchange, body.agentId, {
        proofService: proof,
        requireProof: true,
      });
      return exchange.postComment({ marketId: params.marketId, ...body });
    }
  );
}
