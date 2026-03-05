import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { SupabaseExchangeService } from "./services/supabase-exchange.js";
import { createSupabaseContext, projectUrlFromRef } from "./services/supabase-client.js";
import { registerPublicRoutes } from "./routes/public-routes.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerAgentProofRoutes } from "./routes/agent-proof-routes.js";
import { registerMarketRoutes } from "./routes/market-routes.js";
import { registerOwnerRoutes } from "./routes/owner-routes.js";
import { AgentProofService } from "./services/agent-proof.js";
import { PayPalMarketBillingService } from "./services/paypal-market-billing.js";

const app = Fastify({ logger: true });

if (!process.env.SUPABASE_URL && process.env.SUPABASE_PROJECT_ID) {
  process.env.SUPABASE_URL = projectUrlFromRef(process.env.SUPABASE_PROJECT_ID);
}

const exchange = new SupabaseExchangeService();
await exchange.ready();
const { client: supabaseAuthClient } = createSupabaseContext();
const billing = new PayPalMarketBillingService(supabaseAuthClient);
const agentProof = new AgentProofService(supabaseAuthClient);
await agentProof.ready();

await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true, service: "clawseum-api" }));

await registerPublicRoutes(app, exchange);
await registerAgentRoutes(app, exchange);
await registerAgentProofRoutes(app, exchange, agentProof);
await registerMarketRoutes(app, exchange, agentProof);
await registerOwnerRoutes(app, exchange, supabaseAuthClient, billing);

const autoResolveEnabled = process.env.AUTO_RESOLVE_EXPIRED_MARKETS !== "0";
const marketCloseSweepMs = Math.max(5_000, Number(process.env.MARKET_CLOSE_SWEEP_MS ?? 15_000));

if (autoResolveEnabled) {
  const runSweep = async () => {
    try {
      const result = await exchange.resolveExpiredMarkets();
      if (result.resolved.length > 0) {
        app.log.info(
          {
            resolved: result.resolved.length,
            failed: result.failed.length,
          },
          "Resolved expired markets"
        );
      } else if (result.failed.length > 0) {
        app.log.warn({ failed: result.failed }, "Expired market resolve sweep had failures");
      }
    } catch (error) {
      app.log.error(error, "Expired market resolve sweep failed");
    }
  };

  void runSweep();
  const timer = setInterval(() => {
    void runSweep();
  }, marketCloseSweepMs);
  timer.unref();
}

app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  reply.status(400).send({
    error: message,
  });
});

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
