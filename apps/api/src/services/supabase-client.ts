import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseContext {
  client: SupabaseClient;
  url: string;
}

export function createSupabaseContext(): SupabaseContext {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("SUPABASE_URL is required");
  }
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { client, url };
}

export function projectUrlFromRef(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
}
