import "dotenv/config";
import { SupabaseExchangeService } from "../services/supabase-exchange.js";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const exchange = new SupabaseExchangeService();
  await exchange.reseed(force);
  console.log(`Supabase seed complete${force ? " (force)" : ""}.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Seed failed: ${message}`);
  process.exit(1);
});
