import type { FastifyInstance } from "fastify";
import type { ExchangeContract } from "../services/exchange-contract.js";
import type { AgentProofService } from "../services/agent-proof.js";
import { requireAgentAccess } from "./agent-auth.js";

export async function registerAgentProofRoutes(
  app: FastifyInstance,
  exchange: ExchangeContract,
  proof: AgentProofService
): Promise<void> {
  if (!proof.isEnabled()) {
    return;
  }

  app.post(
    "/api/v1/agent-proof/challenge",
    {
      schema: {
        body: {
          type: "object",
          required: ["agentId", "method", "path"],
          properties: {
            agentId: { type: "string", minLength: 2, maxLength: 80 },
            method: { type: "string", minLength: 3, maxLength: 12 },
            path: { type: "string", minLength: 1, maxLength: 300 },
            agentName: { type: "string", minLength: 2, maxLength: 80 },
            agentVersion: { type: "string", minLength: 1, maxLength: 40 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        agentId: string;
        method: string;
        path: string;
        agentName?: string;
        agentVersion?: string;
      };
      await requireAgentAccess(request, exchange, body.agentId, {
        proofService: proof,
        requireProof: false,
      });
      const action = proof.buildAction(body.method, body.path);
      return proof.createChallenge({
        agentId: body.agentId,
        action,
        agentName: body.agentName,
        agentVersion: body.agentVersion,
      });
    }
  );

  app.get("/api/v1/agent-proof/step/:sessionId/:token", async (request) => {
    const params = request.params as { sessionId: string; token: string };
    const agentId = await requireAgentAccess(request, exchange, undefined, {
      proofService: proof,
      requireProof: false,
    });
    return proof.getStep({
      agentId,
      sessionId: params.sessionId,
      token: params.token,
    });
  });

  app.post(
    "/api/v1/agent-proof/solve/:sessionId",
    {
      schema: {
        body: {
          type: "object",
          required: ["answer", "hmac"],
          properties: {
            answer: { type: "string", minLength: 64, maxLength: 128 },
            hmac: { type: "string", minLength: 64, maxLength: 128 },
          },
        },
      },
    },
    async (request) => {
      const params = request.params as { sessionId: string };
      const body = request.body as { answer: string; hmac: string };
      const agentId = await requireAgentAccess(request, exchange, undefined, {
        proofService: proof,
        requireProof: false,
      });

      return proof.solve({
        agentId,
        sessionId: params.sessionId,
        answer: body.answer,
        hmac: body.hmac,
      });
    }
  );
}
