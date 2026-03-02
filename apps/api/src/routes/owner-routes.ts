import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExchangeContract } from "../services/exchange-contract.js";
import { requireOwnerAuth, requireOwnerEmail } from "./owner-auth.js";

export async function registerOwnerRoutes(
  app: FastifyInstance,
  exchange: ExchangeContract,
  supabase: SupabaseClient
): Promise<void> {
  app.get("/api/v1/owner/me", async (request) => {
    const user = await requireOwnerAuth(request, supabase);
    const ownerEmail = requireOwnerEmail(user);

    return {
      owner: {
        id: user.id,
        email: ownerEmail,
      },
    };
  });

  app.get("/api/v1/owner/agents", async (request) => {
    const user = await requireOwnerAuth(request, supabase);
    const ownerEmail = requireOwnerEmail(user);
    return { agents: await exchange.ownerAgents(ownerEmail) };
  });

  app.post(
    "/api/v1/owner/agents/:agentId/claim",
    {
      schema: {
        params: {
          type: "object",
          required: ["agentId"],
          properties: {
            agentId: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["verificationCode"],
          properties: {
            verificationCode: { type: "string", minLength: 6, maxLength: 16 },
          },
        },
      },
    },
    async (request) => {
      const user = await requireOwnerAuth(request, supabase);
      const ownerEmail = requireOwnerEmail(user);
      const params = request.params as { agentId: string };
      const body = request.body as { verificationCode: string };

      return exchange.claimByOwner({
        agentId: params.agentId,
        verificationCode: body.verificationCode,
        ownerEmail,
      });
    }
  );

  app.post(
    "/api/v1/owner/agents/:agentId/rotate-key",
    {
      schema: {
        params: {
          type: "object",
          required: ["agentId"],
          properties: {
            agentId: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const user = await requireOwnerAuth(request, supabase);
      const ownerEmail = requireOwnerEmail(user);
      const params = request.params as { agentId: string };

      return exchange.rotateAgentApiKey({
        agentId: params.agentId,
        ownerEmail,
      });
    }
  );
}
