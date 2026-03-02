import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

type AgentCaptchaChallengeResponse = {
  session_id: string;
  token: string;
  nonce: string;
  message?: string;
};

type AgentCaptchaStepResponse = {
  data_b64: string;
  instructions: string[];
  nonce: string;
  message?: string;
};

type AgentCaptchaSolveResponse = {
  verified: boolean;
  token: string;
  message?: string;
};

type PendingSession = {
  agentId: string;
  action: string;
  expiresAtMs: number;
};

type ProofClaims = {
  v: 1;
  typ: "agent_proof";
  agentId: string;
  action: string;
  iat: number;
  exp: number;
  jti: string;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_CAPTCHA_BASE_URL = "https://agent-captcha.dhravya.dev";

function parsePositiveInt(input: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Action path is required for agent proof");
  }

  let pathname: string;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    pathname = new URL(trimmed).pathname;
  } else {
    pathname = new URL(trimmed, "http://localhost").pathname;
  }

  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1) {
    return collapsed.replace(/\/+$/g, "");
  }
  return collapsed;
}

function jsonToBase64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64urlJson(input: string): JsonRecord {
  const raw = Buffer.from(input, "base64url").toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid proof token payload");
  }
  return parsed as JsonRecord;
}

function safeString(data: JsonRecord, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${key} in response`);
  }
  return value;
}

function safeStringArray(data: JsonRecord, key: string): string[] {
  const value = data[key];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${key} in response`);
  }
  const result = value.filter((entry): entry is string => typeof entry === "string");
  if (result.length !== value.length) {
    throw new Error(`Invalid ${key} in response`);
  }
  return result;
}

async function readJson(res: Response): Promise<JsonRecord> {
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as JsonRecord;
}

function isExpired(expiresAtMs: number): boolean {
  return Date.now() >= expiresAtMs;
}

function responseMessage(body: JsonRecord, fallback: string): string {
  return typeof body.message === "string" && body.message.trim() ? body.message : fallback;
}

export class AgentProofService {
  private readonly enabled: boolean;
  readonly captchaBaseUrl: string;
  private readonly challengeTtlMs: number;
  private readonly proofTtlMs: number;
  private readonly signingSecret: string;
  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly consumedProofs = new Map<string, number>();

  constructor() {
    this.enabled = (process.env.AGENT_PROOF_ENABLED ?? "1") !== "0";
    this.captchaBaseUrl = (process.env.AGENT_CAPTCHA_BASE_URL?.trim() || DEFAULT_CAPTCHA_BASE_URL).replace(/\/+$/g, "");
    this.challengeTtlMs = parsePositiveInt(process.env.AGENT_PROOF_CHALLENGE_TTL_MS, 30_000, 5_000, 120_000);
    this.proofTtlMs = parsePositiveInt(process.env.AGENT_PROOF_TTL_MS, 90_000, 10_000, 600_000);
    this.signingSecret = process.env.AGENT_PROOF_SIGNING_SECRET?.trim() || randomBytes(32).toString("hex");
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  actionForRequest(request: FastifyRequest): string {
    const pathname = normalizePath(new URL(request.url, "http://localhost").pathname);
    return `${request.method.toUpperCase()}:${pathname}`;
  }

  buildAction(method: string, path: string): string {
    const normalizedMethod = method.trim().toUpperCase();
    if (!/^[A-Z]+$/.test(normalizedMethod)) {
      throw new Error("Invalid action method for agent proof");
    }
    return `${normalizedMethod}:${normalizePath(path)}`;
  }

  async createChallenge(input: {
    agentId: string;
    action: string;
    agentName?: string;
    agentVersion?: string;
  }): Promise<{
    sessionId: string;
    token: string;
    nonce: string;
    action: string;
    expiresInMs: number;
  }> {
    this.cleanup();

    const response = await fetch(`${this.captchaBaseUrl}/api/challenge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_name: input.agentName?.trim() || input.agentId,
        agent_version: input.agentVersion?.trim() || "1.0.0",
      }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(`agent-captcha challenge failed: ${responseMessage(body, "Unable to create challenge")}`);
    }

    const parsed: AgentCaptchaChallengeResponse = {
      session_id: safeString(body, "session_id"),
      token: safeString(body, "token"),
      nonce: safeString(body, "nonce"),
      message: typeof body.message === "string" ? body.message : undefined,
    };

    this.pendingSessions.set(parsed.session_id, {
      agentId: input.agentId,
      action: input.action,
      expiresAtMs: Date.now() + this.challengeTtlMs,
    });

    return {
      sessionId: parsed.session_id,
      token: parsed.token,
      nonce: parsed.nonce,
      action: input.action,
      expiresInMs: this.challengeTtlMs,
    };
  }

  async getStep(input: {
    agentId: string;
    sessionId: string;
    token: string;
  }): Promise<{
    sessionId: string;
    dataB64: string;
    instructions: string[];
    nonce: string;
    action: string;
  }> {
    this.cleanup();
    const pending = this.assertPendingSession(input.sessionId, input.agentId);

    const response = await fetch(
      `${this.captchaBaseUrl}/api/step/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.token)}`
    );
    const body = await readJson(response);
    if (!response.ok) {
      if (response.status >= 400) {
        this.pendingSessions.delete(input.sessionId);
      }
      const message = responseMessage(body, "Unable to fetch challenge step");
      throw new Error(`agent-captcha step failed: ${message}`);
    }

    const parsed: AgentCaptchaStepResponse = {
      data_b64: safeString(body, "data_b64"),
      instructions: safeStringArray(body, "instructions"),
      nonce: safeString(body, "nonce"),
      message: typeof body.message === "string" ? body.message : undefined,
    };

    return {
      sessionId: input.sessionId,
      dataB64: parsed.data_b64,
      instructions: parsed.instructions,
      nonce: parsed.nonce,
      action: pending.action,
    };
  }

  async solve(input: {
    agentId: string;
    sessionId: string;
    answer: string;
    hmac: string;
  }): Promise<{
    verified: true;
    proofToken: string;
    action: string;
    expiresAt: number;
  }> {
    this.cleanup();
    const pending = this.assertPendingSession(input.sessionId, input.agentId);

    const response = await fetch(`${this.captchaBaseUrl}/api/solve/${encodeURIComponent(input.sessionId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        answer: input.answer,
        hmac: input.hmac,
      }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      this.pendingSessions.delete(input.sessionId);
      const message = responseMessage(body, "Challenge solve failed");
      throw new Error(`agent-captcha solve failed: ${message}`);
    }

    const parsed: AgentCaptchaSolveResponse = {
      verified: Boolean(body.verified),
      token: safeString(body, "token"),
      message: typeof body.message === "string" ? body.message : undefined,
    };

    if (!parsed.verified || !parsed.token) {
      this.pendingSessions.delete(input.sessionId);
      throw new Error("agent-captcha solve failed: invalid verification response");
    }

    this.pendingSessions.delete(input.sessionId);
    const { token, expiresAt } = this.issueProofToken({
      agentId: input.agentId,
      action: pending.action,
    });

    return {
      verified: true,
      proofToken: token,
      action: pending.action,
      expiresAt,
    };
  }

  assertProof(input: { token: string; agentId: string; action: string }): void {
    this.cleanup();
    const claims = this.verifyProofToken(input.token);

    if (claims.agentId !== input.agentId) {
      throw new Error("Agent proof token was issued for a different agent");
    }
    if (claims.action !== input.action) {
      throw new Error("Agent proof token action mismatch");
    }
    if (this.consumedProofs.has(claims.jti)) {
      throw new Error("Agent proof token already used; solve a new challenge");
    }

    this.consumedProofs.set(claims.jti, claims.exp * 1_000);
  }

  private assertPendingSession(sessionId: string, agentId: string): PendingSession {
    const pending = this.pendingSessions.get(sessionId);
    if (!pending) {
      throw new Error("No pending agent proof session. Start again with /api/v1/agent-proof/challenge");
    }
    if (pending.agentId !== agentId) {
      throw new Error("Agent proof session belongs to a different agent");
    }
    if (isExpired(pending.expiresAtMs)) {
      this.pendingSessions.delete(sessionId);
      throw new Error("Agent proof session expired. Start again with /api/v1/agent-proof/challenge");
    }
    return pending;
  }

  private issueProofToken(input: { agentId: string; action: string }): { token: string; expiresAt: number } {
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = now + Math.max(1, Math.floor(this.proofTtlMs / 1_000));
    const claims: ProofClaims = {
      v: 1,
      typ: "agent_proof",
      agentId: input.agentId,
      action: input.action,
      iat: now,
      exp: expiresAt,
      jti: randomUUID(),
    };

    const header = {
      alg: "HS256",
      typ: "JWT",
    };

    const encodedHeader = jsonToBase64url(header);
    const encodedPayload = jsonToBase64url(claims);
    const content = `${encodedHeader}.${encodedPayload}`;
    const signature = this.sign(content);
    return {
      token: `${content}.${signature}`,
      expiresAt: expiresAt * 1_000,
    };
  }

  private verifyProofToken(token: string): ProofClaims {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed x-agent-proof token");
    }
    const encodedHeader = parts[0];
    const encodedPayload = parts[1];
    const signature = parts[2];
    if (!encodedHeader || !encodedPayload || !signature) {
      throw new Error("Malformed x-agent-proof token");
    }
    const content = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = this.sign(content);

    const signatureBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expectedSignature, "base64url");
    if (signatureBytes.length !== expectedBytes.length || !timingSafeEqual(signatureBytes, expectedBytes)) {
      throw new Error("Invalid x-agent-proof token signature");
    }

    const header = parseBase64urlJson(encodedHeader);
    const payload = parseBase64urlJson(encodedPayload);
    if (header.alg !== "HS256") {
      throw new Error("Unsupported proof token algorithm");
    }

    const claims: ProofClaims = {
      v: Number(payload.v) as 1,
      typ: typeof payload.typ === "string" ? payload.typ as ProofClaims["typ"] : "agent_proof",
      agentId: safeString(payload, "agentId"),
      action: safeString(payload, "action"),
      iat: Number(payload.iat),
      exp: Number(payload.exp),
      jti: safeString(payload, "jti"),
    };

    if (claims.v !== 1 || claims.typ !== "agent_proof") {
      throw new Error("Unsupported x-agent-proof token version");
    }
    const now = Math.floor(Date.now() / 1_000);
    if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp <= now) {
      throw new Error("Expired x-agent-proof token");
    }

    return claims;
  }

  private sign(content: string): string {
    return createHmac("sha256", this.signingSecret).update(content, "utf8").digest("base64url");
  }

  private cleanup(): void {
    const nowMs = Date.now();
    for (const [sessionId, pending] of this.pendingSessions.entries()) {
      if (isExpired(pending.expiresAtMs)) {
        this.pendingSessions.delete(sessionId);
      }
    }
    for (const [jti, expiresAtMs] of this.consumedProofs.entries()) {
      if (nowMs >= expiresAtMs) {
        this.consumedProofs.delete(jti);
      }
    }
  }
}
