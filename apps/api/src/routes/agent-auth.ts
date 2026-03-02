import type { FastifyRequest } from "fastify";
import type { ExchangeContract } from "../services/exchange-contract.js";
import type { AgentProofService } from "../services/agent-proof.js";

type RequireAgentAccessOptions = {
  proofService?: AgentProofService;
  requireProof?: boolean;
};

export async function requireAgentAccess(
  request: FastifyRequest,
  exchange: ExchangeContract,
  expectedAgentId?: string,
  options?: RequireAgentAccessOptions
): Promise<string> {
  const headerAgentIdRaw = request.headers["x-agent-id"];
  const headerApiKeyRaw = request.headers["x-api-key"];
  const headerProofRaw = request.headers["x-agent-proof"];
  const authRaw = request.headers.authorization;

  const headerAgentId = Array.isArray(headerAgentIdRaw) ? headerAgentIdRaw[0] : headerAgentIdRaw;
  const headerApiKey = Array.isArray(headerApiKeyRaw) ? headerApiKeyRaw[0] : headerApiKeyRaw;
  const headerProof = Array.isArray(headerProofRaw) ? headerProofRaw[0] : headerProofRaw;
  const bearer = typeof authRaw === "string" && authRaw.toLowerCase().startsWith("bearer ")
    ? authRaw.slice("bearer ".length).trim()
    : "";
  const apiKey = headerApiKey?.trim() || bearer;
  const agentId = headerAgentId?.trim() ?? "";

  if (!agentId) {
    throw new Error("Missing x-agent-id header");
  }
  if (expectedAgentId && expectedAgentId !== agentId) {
    throw new Error("Agent id mismatch between request path/body and headers");
  }
  if (!apiKey) {
    throw new Error("Missing API key. Set x-api-key or Authorization: Bearer <key>");
  }

  await exchange.assertAgentAccess({ agentId, apiKey });

  if (options?.requireProof) {
    if (!options.proofService) {
      throw new Error("Agent proof service is not configured");
    }
    if (!options.proofService.isEnabled()) {
      throw new Error("Agent proof is disabled on this server");
    }
    if (!headerProof?.trim()) {
      throw new Error("Missing x-agent-proof header");
    }

    options.proofService.assertProof({
      token: headerProof.trim(),
      agentId,
      action: options.proofService.actionForRequest(request),
    });
  }

  return agentId;
}
