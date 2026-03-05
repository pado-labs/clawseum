import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExchangeContract } from "../services/exchange-contract.js";
import type { PayPalMarketBillingService } from "../services/paypal-market-billing.js";
import { requireOwnerAuth, requireOwnerEmail } from "./owner-auth.js";

export async function registerOwnerRoutes(
  app: FastifyInstance,
  exchange: ExchangeContract,
  supabase: SupabaseClient,
  billing: PayPalMarketBillingService
): Promise<void> {
  app.get("/api/v1/owner/credits", async (request) => {
    const user = await requireOwnerAuth(request, supabase);
    const ownerEmail = requireOwnerEmail(user);
    return billing.getCreditSummary(ownerEmail);
  });

  app.post(
    "/api/v1/owner/paypal/orders",
    {
      schema: {
        body: {
          type: "object",
          required: ["credits"],
          properties: {
            credits: { type: "number", minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const user = await requireOwnerAuth(request, supabase);
      const ownerEmail = requireOwnerEmail(user);
      const body = request.body as { credits: number };
      return billing.createOrder({ ownerEmail, credits: body.credits });
    }
  );

  app.post("/api/v1/owner/paypal/orders/:orderId/capture", async (request) => {
    const user = await requireOwnerAuth(request, supabase);
    const ownerEmail = requireOwnerEmail(user);
    const params = request.params as { orderId: string };
    return billing.captureOrder({ ownerEmail, orderId: params.orderId });
  });

  app.post(
    "/api/v1/owner/markets",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "question"],
          properties: {
            id: { type: "string", minLength: 2, maxLength: 120 },
            question: { type: "string", minLength: 6, maxLength: 240 },
            closeAt: { type: ["number", "null"] },
          },
        },
      },
    },
    async (request) => {
      const user = await requireOwnerAuth(request, supabase);
      const ownerEmail = requireOwnerEmail(user);
      const body = request.body as { id: string; question: string; closeAt?: number | null };
      const consumed = await billing.consumeOneCredit(ownerEmail);

      try {
        const created = await exchange.createMarket({
          id: body.id.trim(),
          question: body.question.trim(),
          closeAt: body.closeAt ?? null,
        });

        return {
          ...(typeof created === "object" && created ? created : { ok: true }),
          credit: {
            sourceOrderId: consumed.orderId,
            remainingCredits: consumed.availableCredits,
          },
        };
      } catch (error) {
        await billing.restoreOneCredit(consumed.orderId);
        throw error;
      }
    }
  );

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
