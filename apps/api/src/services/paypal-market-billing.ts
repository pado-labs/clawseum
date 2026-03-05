import type { SupabaseClient } from "@supabase/supabase-js";

type PayPalOrderLink = { rel?: string; href?: string };

type PayPalCreateOrderResponse = {
  id?: string;
  status?: string;
  links?: PayPalOrderLink[];
};

type PayPalCaptureResponse = {
  status?: string;
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
      }>;
    };
  }>;
};

type OwnerPaymentOrderRow = {
  order_id: string;
  owner_email: string;
  credits: number;
  remaining_credits: number;
  amount_usd: number | string;
  currency: string;
  status: "CREATED" | "COMPLETED" | "VOIDED";
  capture_id: string | null;
};

function toNum(input: string | number): number {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isFinite(value) ? value : 0;
}

function round2(input: number): number {
  return Math.round(input * 100) / 100;
}

export class PayPalMarketBillingService {
  private readonly paypalBaseUrl: string;
  private readonly unitPriceUsd: number;

  constructor(private readonly client: SupabaseClient) {
    const mode = (process.env.PAYPAL_ENV ?? "sandbox").toLowerCase();
    this.paypalBaseUrl = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    this.unitPriceUsd = Math.max(0.01, Number(process.env.MARKET_CREATION_PRICE_USD ?? 3));
  }

  async getCreditSummary(ownerEmail: string): Promise<{
    availableCredits: number;
    unitPriceUsd: number;
  }> {
    const { data, error } = await this.client
      .from("owner_payment_orders")
      .select("remaining_credits")
      .eq("owner_email", ownerEmail)
      .eq("status", "COMPLETED");

    if (error) {
      throw new Error(`Failed to load market credits: ${error.message}`);
    }

    const availableCredits = (data ?? []).reduce((sum, row) => {
      const value = typeof row.remaining_credits === "number" ? row.remaining_credits : Number(row.remaining_credits ?? 0);
      return sum + (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
    }, 0);

    return {
      availableCredits,
      unitPriceUsd: this.unitPriceUsd,
    };
  }

  async createOrder(input: { ownerEmail: string; credits: number }): Promise<{
    orderId: string;
    status: string;
    approvalUrl: string;
    credits: number;
    amountUsd: number;
    unitPriceUsd: number;
  }> {
    const credits = Math.max(1, Math.floor(input.credits));
    const amountUsd = round2(credits * this.unitPriceUsd);
    const accessToken = await this.fetchAccessToken();

    const returnUrl = process.env.PAYPAL_RETURN_URL;
    const cancelUrl = process.env.PAYPAL_CANCEL_URL;
    if (!returnUrl || !cancelUrl) {
      throw new Error("PAYPAL_RETURN_URL and PAYPAL_CANCEL_URL are required");
    }

    const response = await fetch(`${this.paypalBaseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "USD",
              value: amountUsd.toFixed(2),
            },
            custom_id: input.ownerEmail,
            description: `Clawseum market credits (${credits})`,
          },
        ],
        application_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: "PAY_NOW",
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PayPal create order failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as PayPalCreateOrderResponse;
    if (!payload.id) {
      throw new Error("PayPal create order failed: missing order id");
    }

    const approvalUrl = payload.links?.find((link) => link.rel === "approve")?.href;
    if (!approvalUrl) {
      throw new Error("PayPal create order failed: missing approval URL");
    }

    const { error } = await this.client.from("owner_payment_orders").upsert(
      {
        order_id: payload.id,
        owner_email: input.ownerEmail,
        credits,
        remaining_credits: 0,
        amount_usd: amountUsd,
        currency: "USD",
        status: "CREATED",
      },
      { onConflict: "order_id" }
    );

    if (error) {
      throw new Error(`Failed to persist payment order: ${error.message}`);
    }

    return {
      orderId: payload.id,
      status: payload.status ?? "CREATED",
      approvalUrl,
      credits,
      amountUsd,
      unitPriceUsd: this.unitPriceUsd,
    };
  }

  async captureOrder(input: { ownerEmail: string; orderId: string }): Promise<{
    orderId: string;
    status: string;
    creditsAdded: number;
    captureId: string | null;
    availableCredits: number;
  }> {
    const { data: existing, error: existingError } = await this.client
      .from("owner_payment_orders")
      .select("order_id, owner_email, credits, remaining_credits, amount_usd, currency, status, capture_id")
      .eq("order_id", input.orderId)
      .maybeSingle<OwnerPaymentOrderRow>();

    if (existingError) {
      throw new Error(`Failed to load payment order: ${existingError.message}`);
    }
    if (!existing) {
      throw new Error(`Unknown payment order: ${input.orderId}`);
    }
    if (existing.owner_email !== input.ownerEmail) {
      throw new Error("Payment order owner mismatch");
    }

    if (existing.status === "COMPLETED") {
      const summary = await this.getCreditSummary(input.ownerEmail);
      return {
        orderId: input.orderId,
        status: "COMPLETED",
        creditsAdded: 0,
        captureId: existing.capture_id,
        availableCredits: summary.availableCredits,
      };
    }

    const accessToken = await this.fetchAccessToken();
    const response = await fetch(`${this.paypalBaseUrl}/v2/checkout/orders/${encodeURIComponent(input.orderId)}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: "{}",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PayPal capture failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as PayPalCaptureResponse;
    const capture = payload.purchase_units?.[0]?.payments?.captures?.[0];
    const captureStatus = (capture?.status ?? payload.status ?? "").toUpperCase();
    if (captureStatus !== "COMPLETED") {
      throw new Error(`PayPal capture not completed: ${captureStatus || "UNKNOWN"}`);
    }

    const { error: updateError } = await this.client
      .from("owner_payment_orders")
      .update({
        status: "COMPLETED",
        capture_id: capture?.id ?? null,
        remaining_credits: existing.credits,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", existing.order_id)
      .eq("status", "CREATED");

    if (updateError) {
      throw new Error(`Failed to finalize payment order: ${updateError.message}`);
    }

    const summary = await this.getCreditSummary(input.ownerEmail);
    return {
      orderId: input.orderId,
      status: "COMPLETED",
      creditsAdded: existing.credits,
      captureId: capture?.id ?? null,
      availableCredits: summary.availableCredits,
    };
  }

  async consumeOneCredit(ownerEmail: string): Promise<{ orderId: string; remainingCreditsInOrder: number; availableCredits: number }> {
    const { data, error } = await this.client
      .from("owner_payment_orders")
      .select("order_id, remaining_credits")
      .eq("owner_email", ownerEmail)
      .eq("status", "COMPLETED")
      .gt("remaining_credits", 0)
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) {
      throw new Error(`Failed to load usable credits: ${error.message}`);
    }

    const row = (data ?? [])[0] as { order_id: string; remaining_credits: number } | undefined;
    if (!row) {
      throw new Error("No market credits available. Please purchase credits first.");
    }

    const next = Math.max(0, Math.floor(toNum(row.remaining_credits)) - 1);
    const { error: updateError } = await this.client
      .from("owner_payment_orders")
      .update({
        remaining_credits: next,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", row.order_id)
      .eq("remaining_credits", row.remaining_credits)
      .gt("remaining_credits", 0);

    if (updateError) {
      throw new Error(`Failed to consume market credit: ${updateError.message}`);
    }

    const summary = await this.getCreditSummary(ownerEmail);
    return {
      orderId: row.order_id,
      remainingCreditsInOrder: next,
      availableCredits: summary.availableCredits,
    };
  }

  async restoreOneCredit(orderId: string): Promise<void> {
    const { data, error } = await this.client
      .from("owner_payment_orders")
      .select("remaining_credits")
      .eq("order_id", orderId)
      .maybeSingle<{ remaining_credits: number }>();

    if (error || !data) {
      return;
    }

    const next = Math.max(0, Math.floor(toNum(data.remaining_credits)) + 1);
    await this.client
      .from("owner_payment_orders")
      .update({ remaining_credits: next, updated_at: new Date().toISOString() })
      .eq("order_id", orderId);
  }

  private async fetchAccessToken(): Promise<string> {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required");
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch(`${this.paypalBaseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PayPal token request failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new Error("PayPal token response missing access_token");
    }
    return json.access_token;
  }
}
