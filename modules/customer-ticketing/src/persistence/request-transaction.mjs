import { createHash } from 'node:crypto';
import { applyEvent } from '../domain/response-clock.mjs';

const SCOPE = 'request-event:v1';
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
}
function stable(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  throw new TypeError('command must contain only plain JSON values');
}

/** Credential-independent application transaction. NOT an authorization boundary.
 * Caller must authenticate/authorize tenant, request, actor and evidence first.
 * repository.transaction must rollback on any error and commit before returning.
 * Its tx methods must be tenant-scoped, lock receipt key before aggregate, and
 * enforce unique tenant/event and tenant/outbox identities. See integration doc.
 * There is deliberately no mail/model/network call inside the transaction.
 */
export async function commitRequestEvent(repository, input) {
  for (const field of ['tenantId', 'requestId', 'idempotencyKey']) text(input[field], field);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new TypeError('expectedVersion must be a nonnegative safe integer');
  const {tenantId, requestId, idempotencyKey, expectedVersion} = input;
  // Snapshot before the first await: callers cannot mutate an in-flight command.
  const event = JSON.parse(stable(input.event));
  const fingerprint = createHash('sha256').update(stable({requestId, expectedVersion, event})).digest('hex');
  return repository.transaction(async tx => {
    await tx.lockIdempotency(tenantId, SCOPE, idempotencyKey);
    const receipt = await tx.getReceipt(tenantId, SCOPE, idempotencyKey);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error('idempotency key reused with different command');
      return structuredClone(receipt.result);
    }
    const current = await tx.lockRequest(tenantId, requestId);
    if (!current) throw new Error('request not found');
    if (current.tenantId !== tenantId || current.request.id !== requestId) throw new Error('repository scope mismatch');
    if (current.version !== expectedVersion) throw new Error('request version conflict');
    const request = applyEvent(current.request, event);
    const changed = request.events.length !== current.request.events.length;
    if (changed && current.version === Number.MAX_SAFE_INTEGER) throw new Error('request version exhausted');
    const version = current.version + (changed ? 1 : 0);
    const result = {version, request};
    if (changed) {
      const canonical = request.events.find(item => item.id === event.id);
      await tx.saveRequest(tenantId, requestId, expectedVersion, version, request);
      await tx.appendEvent(tenantId, requestId, version, canonical);
      await tx.replaceObligations(tenantId, requestId, request.responseObligations);
      await tx.enqueue(tenantId, {eventId:canonical.id, requestId, version,
        kind:'refresh_projection', dedupeKey:`request:${requestId}:version:${version}`});
    }
    await tx.saveReceipt(tenantId, SCOPE, idempotencyKey, {fingerprint, result});
    return structuredClone(result);
  });
}
