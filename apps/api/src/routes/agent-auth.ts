import type { FastifyRequest } from "fastify";
import type { ExchangeContract } from "../services/exchange-contract.js";

export async function requireAgentAccess(
  request: FastifyRequest,
  exchange: ExchangeContract,
  expectedAgentId?: string
): Promise<string> {
  const headerAgentIdRaw = request.headers["x-agent-id"];
  const headerApiKeyRaw = request.headers["x-api-key"];
  const authRaw = request.headers.authorization;

  const headerAgentId = Array.isArray(headerAgentIdRaw) ? headerAgentIdRaw[0] : headerAgentIdRaw;
  const headerApiKey = Array.isArray(headerApiKeyRaw) ? headerApiKeyRaw[0] : headerApiKeyRaw;
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
  return agentId;
}
