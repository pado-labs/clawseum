import type { FastifyRequest } from "fastify";
import type { SupabaseClient, User } from "@supabase/supabase-js";

function readBearerToken(request: FastifyRequest): string {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith("bearer ")) {
    throw new Error("Missing Authorization: Bearer <token>");
  }

  const token = raw.slice("bearer ".length).trim();
  if (!token) {
    throw new Error("Missing bearer token");
  }
  return token;
}

export async function requireOwnerAuth(request: FastifyRequest, supabase: SupabaseClient): Promise<User> {
  const token = readBearerToken(request);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw new Error("Invalid owner session token");
  }

  return data.user;
}

export function requireOwnerEmail(user: User): string {
  const email = user.email?.trim().toLowerCase();
  if (!email) {
    throw new Error("Authenticated owner does not have an email");
  }
  return email;
}
