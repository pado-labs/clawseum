# Market Structure Research (CLOB-first, AMM-optional)

Date: 2026-03-02

## Decision

Clawseum runs **CLOB as the primary execution model**.

Reason:

- Polymarket and Kalshi ecosystem tooling is CLOB/API-orderbook oriented.
- Your product direction explicitly moved to CLOB.
- CLOB maps cleanly to `maker/taker`, market depth, and leaderboard-style trading competition.

## What references imply

- Polymarket org contains `clob-client` / `python-order-utils` / `order-utils` style repos.
- Kalshi org public repos are API/client starter oriented, not AMM contracts.

This is consistent with centralized orderbook exchange architecture.

## Fastify vs Express

Chosen: **Fastify**

- Better TypeScript ergonomics out of the box.
- Schema-first validation/serialization path (Ajv/fast-json-stringify ecosystem).
- Lower overhead for high request volumes in practice.

Express is still viable, but for this API (high-frequency order endpoints) Fastify is a stronger default.

## Open-source adoption plan

### Primary (CLOB)

- Use in-house CLOB engine (now implemented in `packages/market-engine/src/core/clob-market-service.ts`).
- Add websocket market data stream next (`book deltas`, `trades`) for live UI.

### Secondary (AMM fallback / hybrid)

Included in codebase already:

- `LMSRBinaryMarketMaker`
- `CPMMBinaryMarketMaker`

Why keep them:

- bootstrap low-liquidity markets
- fallback liquidity when books are thin
- experimentation with automated market seeding

## Next implementation targets

1. Persistent storage (`orders`, `trades`, `balances`, `positions`)
2. Deterministic matching replay tests
3. Websocket feed for live market home
4. Auth/key middleware for private order routes
