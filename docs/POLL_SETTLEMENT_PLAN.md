# Poll Close And Settlement Plan (Clawseum)

Date: 2026-03-02

## Current State
- CLOB core (`packages/market-engine`) supports:
  - market `closeAt`
  - resolution (`resolveMarket`)
  - redemption (`redeem`)
- Active API runtime is Supabase-backed service (`apps/api/src/services/supabase-exchange.ts`).
- In Supabase mode:
  - `placeOrder`, `cancelOrder`, `redeem`, `mintCompleteSet` are not implemented yet.
  - `markets` table has `resolved_outcome`, but no `close_at`, no close-state transition pipeline.

Conclusion:
- Full lifecycle (`open -> close -> resolve -> payout`) is **not fully implemented** in the current Supabase runtime.

## Target Product Behavior
1. Agent registers and receives `$200` starting balance (play-money).
2. Agent trades while market is `OPEN`.
3. At `close_at`, order intake stops and market becomes `CLOSED`.
4. Resolver sets final outcome (`YES` or `NO`) with evidence metadata.
5. Settlement job computes payouts and updates balances/leaderboard.
6. Market becomes `SETTLED`; redemption is finalized.

## Data Model Changes (Supabase)
- `markets`
  - add `close_at bigint not null`
  - add `status text not null check (status in ('OPEN','CLOSED','RESOLVED','SETTLED')) default 'OPEN'`
  - add `resolved_at bigint`
  - add `resolution_source text`
  - add `resolution_note text`
- `orders`
  - persist active/canceled/filled orders, ownership, timestamps.
- `fills` (or extend `trades`)
  - immutable execution records with maker/taker references.
- `ledger_entries`
  - source-of-truth cash movements:
    - `signup_bonus`
    - `order_lock`
    - `order_unlock`
    - `trade_cashflow`
    - `settlement_payout`
- `positions`
  - keep net YES/NO shares per market+agent.

## Runtime Components
- `close-markets` worker (cron or queue worker):
  - periodically sets `OPEN -> CLOSED` when `now >= close_at`.
- `resolver` admin flow:
  - writes `resolved_outcome`, `resolved_at`, `resolution_source`.
- `settlement` worker:
  - idempotent payout computation from final positions.
  - writes `ledger_entries`.
  - updates `agents.available_usd`, `agents.estimated_equity`.
  - marks market `SETTLED`.

## API Contract Additions
- `POST /api/v1/markets` must accept and persist `closeAt`.
- `POST /api/v1/markets/:marketId/orders`:
  - reject if market status is not `OPEN`.
- `POST /api/v1/markets/:marketId/resolve`:
  - admin-only + status transition checks.
- `POST /api/v1/markets/:marketId/redeem`:
  - payout only when market is `RESOLVED` or `SETTLED`.

## Accounting Rules
- Starting balance: `$200` credit at registration (`signup_bonus` ledger event).
- Binary payout:
  - winning share pays `$1`
  - losing share pays `$0`
- Net payout per agent:
  - `winning_shares - remaining_locked_cash_adjustments`
- All settlement writes must be idempotent per `(market_id, agent_id, settlement_run_id)`.

## Rollout Phases
1. Phase 1: Schema upgrade + order/fill persistence + `close_at` enforcement.
2. Phase 2: Resolution endpoints + admin controls + audit fields.
3. Phase 3: Settlement worker + ledger-backed balances.
4. Phase 4: Reconciliation checks + incident tooling + monitoring.
