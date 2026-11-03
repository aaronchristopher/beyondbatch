/** Internal trusted-worker cost gate, not an HTTP API or model adapter.
 * Money is integer USD millionths; monthly periods are UTC. An immutable
 * attempt key spans all months. Only the first committed markDispatched grants
 * dispatch; unknown outcomes retain the entire reservation without a timeout,
 * including a conservative hold against later months until reconciled.
 * The caller must reserve a verified upper bound including reasoning/output,
 * tools, retries and surcharges before making any paid call. No prices are
 * assumed here. Provider retries require their own reserved attempt and
 * outcome reconciliation; this ledger cannot make an external call atomic.
 * dispatchAllowed is a one-time immediate admission, never a queued permission;
 * the future caller must enforce dispatchBefore before initiating the paid call.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_MONEY = 1_000_000_000_000;
export const DEFAULT_AI_MONTHLY_LIMIT_MICROS = 25_000_000;

export class AiBudgetError extends Error {
  constructor(code = 'AI_BUDGET_UNAVAILABLE', statusCode = 503) {
    super(code === 'AI_BUDGET_UNAVAILABLE' ? 'AI budget storage unavailable' : 'AI budget operation refused');
    this.name = 'AiBudgetError'; this.code = code; this.statusCode = statusCode;
  }
}
const refuse = code => { throw new AiBudgetError(code, 409); };
function money(value, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > MAX_MONEY) throw new TypeError('Invalid AI budget amount');
  return value;
}
function identity(value) {
  if (!value || typeof value.attemptKey !== 'string' || !KEY.test(value.attemptKey)
      || typeof value.fingerprint !== 'string' || !HASH.test(value.fingerprint)) throw new TypeError('Invalid AI budget attempt');
  return { attemptKey: value.attemptKey, fingerprint: value.fingerprint };
}
function clockValue(clock) {
  try {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() < 0 || now.getUTCFullYear() > 9999) throw new Error();
    const iso = now.toISOString();
    return { iso, month: `${iso.slice(0, 7)}-01` };
  } catch { throw new AiBudgetError(); }
}
function amount(value) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return money(parsed, true);
}
function project(row) {
  return { attemptKey: row.attempt_key, fingerprint: row.fingerprint,
    month: row.billing_month, state: row.state, maxCostMicros: amount(row.max_cost_micros),
    actualCostMicros: row.actual_cost_micros === null ? null : amount(row.actual_cost_micros) };
}

export function createPostgresAiBudget({ pool, tenantId, monthlyLimitMicros = DEFAULT_AI_MONTHLY_LIMIT_MICROS,
  clock = () => new Date() } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof tenantId !== 'string' || !UUID.test(tenantId)
      || typeof clock !== 'function') throw new TypeError('Trusted pool, tenant and clock required');
  money(monthlyLimitMicros);
  async function transact(operation) {
    const started = clockValue(clock);
    let client, begun = false, uncertain = true;
    try {
      client = await pool.connect();
      await client.query('BEGIN'); begun = true; uncertain = false;
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const tenant = await client.query("SELECT id FROM bb.tenants WHERE id=$1 AND status IN ('pilot','active')", [tenantId]);
      if (tenant.rowCount !== 1) refuse('AI_TENANT_DISABLED');
      await client.query(`INSERT INTO bb.ai_budget_policies(tenant_id,monthly_limit_micros) VALUES($1,$2)
        ON CONFLICT(tenant_id) DO NOTHING`, [tenantId, monthlyLimitMicros]);
      const policies = await client.query(`SELECT monthly_limit_micros,blocked_at FROM bb.ai_budget_policies
        WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
      if (policies.rowCount !== 1 || amount(policies.rows[0].monthly_limit_micros) !== monthlyLimitMicros) refuse('AI_BUDGET_POLICY_CONFLICT');
      // Connection/row-lock waits may cross month-end. Admission uses the time
      // after serialization, not a timestamp captured before the wait.
      const time = clockValue(clock);
      if (time.iso < started.iso) throw new AiBudgetError();
      const result = await operation(client, time, policies.rows[0]);
      uncertain = true;
      await client.query('COMMIT'); begun = false; uncertain = false;
      return result;
    } catch (error) {
      if (client && begun) { try { await client.query('ROLLBACK'); } catch { uncertain = true; } }
      if (error instanceof AiBudgetError) throw error;
      throw new AiBudgetError();
    } finally {
      if (client) { try { client.release(uncertain ? new Error('discard uncertain AI budget connection') : undefined); } catch { throw new AiBudgetError(); } }
    }
  }
  async function find(client, id) {
    const result = await client.query(`SELECT attempt_key,fingerprint,billing_month::text,state,max_cost_micros,actual_cost_micros
      FROM bb.ai_budget_attempts WHERE tenant_id=$1 AND attempt_key=$2`, [tenantId, id.attemptKey]);
    if (result.rowCount === 0) return null;
    if (result.rowCount !== 1 || result.rows[0].fingerprint !== id.fingerprint) refuse('AI_ATTEMPT_CONFLICT');
    return project(result.rows[0]);
  }
  async function totals(client, time, policy) {
    const result = await client.query(`SELECT
      coalesce(sum(CASE WHEN state IN ('settled','overrun') THEN actual_cost_micros ELSE 0 END)
        FILTER (WHERE billing_month=$2::date),0)::text AS spent,
      coalesce(sum(max_cost_micros) FILTER (WHERE billing_month=$2::date AND state IN ('reserved','dispatched')),0)::text AS reserved,
      coalesce(sum(max_cost_micros) FILTER (WHERE billing_month<>$2::date AND state IN ('reserved','dispatched')),0)::text AS prior_unresolved
      FROM bb.ai_budget_attempts WHERE tenant_id=$1`, [tenantId, time.month]);
    const row = result.rows[0], spentMicros = amount(row.spent), reservedMicros = amount(row.reserved);
    const priorUnresolvedMicros = amount(row.prior_unresolved);
    return { month: time.month, limitMicros: monthlyLimitMicros, spentMicros, reservedMicros,
      remainingMicros: Math.max(0, monthlyLimitMicros - spentMicros - reservedMicros - priorUnresolvedMicros),
      priorUnresolvedMicros, blocked: policy.blocked_at !== null };
  }
  return Object.freeze({
    summary() { return transact(totals); },
    async reserve(input) {
      const id = identity(input), maxCostMicros = money(input.maxCostMicros);
      return transact(async (client, time, policy) => {
        const existing = await find(client, id);
        if (existing && existing.maxCostMicros !== maxCostMicros) refuse('AI_ATTEMPT_CONFLICT');
        const budget = await totals(client, time, policy);
        if (budget.blocked) return { accepted: false, reason: 'budget_blocked', budget };
        if (existing) return { accepted: existing.state !== 'cancelled', replayed: true,
          ...(existing.state === 'cancelled' ? { reason: 'attempt_cancelled' } : {}), attempt: existing, budget };
        if (maxCostMicros > budget.remainingMicros) return { accepted: false, reason: 'budget_exhausted', budget };
        await client.query(`INSERT INTO bb.ai_budget_attempts
          (tenant_id,attempt_key,fingerprint,billing_month,max_cost_micros,state,reserved_at)
          VALUES($1,$2,$3,$4::date,$5,'reserved',$6)`, [tenantId, id.attemptKey, id.fingerprint, time.month, maxCostMicros, time.iso]);
        return { accepted: true, replayed: false, attempt: await find(client, id), budget: await totals(client, time, policy) };
      });
    },
    async markDispatched(input) {
      const id = identity(input);
      return transact(async (client, time, policy) => {
        const item = await find(client, id);
        if (!item) refuse('AI_ATTEMPT_MISSING');
        if (policy.blocked_at !== null) return { dispatchAllowed: false, reason: 'budget_blocked', attempt: item };
        if (item.state !== 'reserved') return { dispatchAllowed: false, reason: 'attempt_already_claimed', attempt: item };
        const dispatchTime = clockValue(clock);
        if (dispatchTime.iso < time.iso) throw new AiBudgetError();
        if (item.month !== dispatchTime.month) return { dispatchAllowed: false, reason: 'reservation_month_elapsed', attempt: item };
        await client.query(`UPDATE bb.ai_budget_attempts SET state='dispatched',dispatched_at=$3
          WHERE tenant_id=$1 AND attempt_key=$2`, [tenantId, id.attemptKey, dispatchTime.iso]);
        const dispatchBefore = new Date(Date.UTC(Number(dispatchTime.month.slice(0, 4)), Number(dispatchTime.month.slice(5, 7)), 1)).toISOString();
        return { dispatchAllowed: true, dispatchBefore, attempt: await find(client, id) };
      });
    },
    async settle(input) {
      const id = identity(input), actualCostMicros = money(input.actualCostMicros, true);
      return transact(async (client, time, policy) => {
        const item = await find(client, id);
        if (!item) refuse('AI_ATTEMPT_MISSING');
        if (['settled', 'overrun'].includes(item.state)) {
          if (item.actualCostMicros !== actualCostMicros) refuse('AI_ATTEMPT_CONFLICT');
          return { settled: true, replayed: true, overrun: item.state === 'overrun', attempt: item, budget: await totals(client, time, policy) };
        }
        if (item.state !== 'dispatched') refuse('AI_ATTEMPT_NOT_DISPATCHED');
        const overrun = actualCostMicros > item.maxCostMicros;
        await client.query(`UPDATE bb.ai_budget_attempts SET state=$3,actual_cost_micros=$4,finished_at=$5
          WHERE tenant_id=$1 AND attempt_key=$2`, [tenantId, id.attemptKey, overrun ? 'overrun' : 'settled', actualCostMicros, time.iso]);
        if (overrun) {
          await client.query(`UPDATE bb.ai_budget_policies SET blocked_at=coalesce(blocked_at,$2),blocked_reason='reservation_exceeded'
            WHERE tenant_id=$1`, [tenantId, time.iso]);
          policy = { ...policy, blocked_at: time.iso };
        }
        return { settled: true, replayed: false, overrun, attempt: await find(client, id), budget: await totals(client, time, policy) };
      });
    },
    async cancelBeforeDispatch(input) {
      const id = identity(input);
      return transact(async (client, time, policy) => {
        const item = await find(client, id);
        if (!item) refuse('AI_ATTEMPT_MISSING');
        if (item.state === 'cancelled') return { cancelled: true, replayed: true, attempt: item, budget: await totals(client, time, policy) };
        if (item.state !== 'reserved') refuse('AI_ATTEMPT_ALREADY_DISPATCHED');
        await client.query(`UPDATE bb.ai_budget_attempts SET state='cancelled',finished_at=$3
          WHERE tenant_id=$1 AND attempt_key=$2`, [tenantId, id.attemptKey, time.iso]);
        return { cancelled: true, replayed: false, attempt: await find(client, id), budget: await totals(client, time, policy) };
      });
    },
  });
}
