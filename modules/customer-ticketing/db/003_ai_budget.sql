-- Durable provider-neutral AI cost admission; USD millionths, UTC calendar months.
-- Apply after 001_core.sql only through the approved migration process.
-- This migration creates no roles, grants, credentials, model calls or live jobs.
BEGIN;
CREATE TABLE bb.ai_budget_policies (
  tenant_id uuid PRIMARY KEY REFERENCES bb.tenants(id),
  monthly_limit_micros bigint NOT NULL CHECK (monthly_limit_micros BETWEEN 1 AND 1000000000000),
  blocked_at timestamptz,
  blocked_reason text,
  CHECK ((blocked_at IS NULL AND blocked_reason IS NULL)
      OR (blocked_at IS NOT NULL AND isfinite(blocked_at) AND blocked_reason IS NOT NULL
          AND blocked_reason = 'reservation_exceeded'))
);

CREATE TABLE bb.ai_budget_attempts (
  tenant_id uuid NOT NULL REFERENCES bb.ai_budget_policies(tenant_id),
  attempt_key text NOT NULL CHECK (attempt_key ~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  billing_month date NOT NULL CHECK (isfinite(billing_month) AND extract(day FROM billing_month) = 1),
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros BETWEEN 1 AND 1000000000000),
  state text NOT NULL CHECK (state IN ('reserved', 'dispatched', 'settled', 'cancelled', 'overrun')),
  actual_cost_micros bigint CHECK (actual_cost_micros BETWEEN 0 AND 1000000000000),
  reserved_at timestamptz NOT NULL CHECK (isfinite(reserved_at)),
  dispatched_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_key),
  CHECK (billing_month = date_trunc('month', reserved_at AT TIME ZONE 'UTC')::date),
  CHECK (dispatched_at IS NULL OR (isfinite(dispatched_at) AND dispatched_at >= reserved_at
      AND billing_month = date_trunc('month', dispatched_at AT TIME ZONE 'UTC')::date)),
  CHECK (finished_at IS NULL OR (isfinite(finished_at) AND finished_at >= coalesce(dispatched_at, reserved_at))),
  CHECK ((state = 'reserved' AND dispatched_at IS NULL AND finished_at IS NULL AND actual_cost_micros IS NULL)
      OR (state = 'dispatched' AND dispatched_at IS NOT NULL AND finished_at IS NULL AND actual_cost_micros IS NULL)
      OR (state = 'cancelled' AND dispatched_at IS NULL AND finished_at IS NOT NULL AND actual_cost_micros IS NULL)
      OR (state = 'settled' AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL AND actual_cost_micros <= max_cost_micros)
      OR (state = 'overrun' AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL AND actual_cost_micros > max_cost_micros)),
  CHECK ((state IN ('settled', 'overrun')) = (actual_cost_micros IS NOT NULL))
);
CREATE INDEX ai_budget_month ON bb.ai_budget_attempts(tenant_id, billing_month);

ALTER TABLE bb.ai_budget_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE bb.ai_budget_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON bb.ai_budget_policies
  USING (tenant_id = bb.current_tenant_id()) WITH CHECK (tenant_id = bb.current_tenant_id());
ALTER TABLE bb.ai_budget_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bb.ai_budget_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON bb.ai_budget_attempts
  USING (tenant_id = bb.current_tenant_id()) WITH CHECK (tenant_id = bb.current_tenant_id());
REVOKE ALL ON bb.ai_budget_policies, bb.ai_budget_attempts FROM PUBLIC;
COMMIT;
