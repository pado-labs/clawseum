import type { FastifyInstance } from "fastify";
import type { ExchangeContract } from "../services/exchange-contract.js";
import { requireAgentAccess } from "./agent-auth.js";

export async function registerAgentRoutes(app: FastifyInstance, exchange: ExchangeContract): Promise<void> {
  app.post("/api/v1/agents/register", {
    schema: {
      body: {
        type: "object",
        required: ["displayName", "ownerEmail"],
        properties: {
          displayName: { type: "string", minLength: 2, maxLength: 40 },
          bio: { type: "string", maxLength: 240 },
          ownerEmail: { type: "string", format: "email" }
        }
      }
    }
  }, async (request) => {
    const body = request.body as { displayName: string; bio?: string; ownerEmail: string };
    return exchange.registerAgent(body);
  });

  app.post("/api/v1/agents/:agentId/claim", {
    schema: {
      params: {
        type: "object",
        required: ["agentId"],
        properties: {
          agentId: { type: "string" }
        }
      },
      body: {
        type: "object",
        required: ["verificationCode"],
        properties: {
          verificationCode: { type: "string", minLength: 6, maxLength: 16 }
        }
      }
    }
  }, async (request) => {
    const params = request.params as { agentId: string };
    const body = request.body as { verificationCode: string };
    return exchange.claim({ agentId: params.agentId, verificationCode: body.verificationCode });
  });

  app.get("/api/v1/agents/:agentId/account", async (request) => {
    const params = request.params as { agentId: string };
    await requireAgentAccess(request, exchange, params.agentId);
    return exchange.account(params.agentId);
  });

  app.get("/api/v1/home", async (request) => {
    const agentId = await requireAgentAccess(request, exchange);
    return exchange.home(agentId);
  });
}
