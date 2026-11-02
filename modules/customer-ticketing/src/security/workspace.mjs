import { deriveClock, replayRequest } from '../domain/response-clock.mjs';
import { projectOutlookAction } from './outlook-links.mjs';

/** Server-side projection. Principal must come from a verified session, never query/body data. */
export function canReadRequest(principal, request) {
  if (!principal || principal.tenantId !== request.tenantId || request.classification !== 'customer_operations') return false;
  if (!['pm', 'department', 'president'].includes(principal.role)) return false;
  if (!principal.customerIds.includes(request.customerId)) return false;
  if (principal.role === 'president') return principal.customerIds.includes(request.customerId);
  if (principal.role === 'pm') return request.ownerId === principal.id || request.backupId === principal.id;
  return principal.departmentIds.includes(request.departmentId) && principal.customerIds.includes(request.customerId);
}

export function projectWorkspace({ principal, requests, now, coverage }) {
  if (!principal || !Array.isArray(principal.customerIds) || !Array.isArray(principal.departmentIds)) throw new Error('Verified principal required');
  const instant = new Date(now).toISOString();
  const visible = requests.filter(request => canReadRequest(principal, request))
    .map(request => ({...request,clock:replayRequest(request.clock)}));
  const rows = visible.map(request => {
    const clock = deriveClock(request.clock, instant);
    return {
      id: request.id, customer: request.customer, subject: request.subject,
      ...(typeof request.emailSubject === 'string' ? { emailSubject: request.emailSubject } : {}),
      owner: request.owner || 'Assignment needs review', department: request.department || 'Triage',
      receivedAt: request.clock.receivedAt, dueAt: clock.dueAt,
      lastMeaningfulResponseAt: request.clock.lastMeaningfulResponseAt,
      status: request.clock.status, nextAction: request.nextAction,
      remainingMs: clock.remainingMs, band: clock.band,
      // This is a reviewed operational synopsis. Raw email and attachment objects are NEVER projected here.
      evidenceSummary: request.operationalEvidenceSummary || 'Evidence awaits review',
      outlookAction: projectOutlookAction({principal,request,coverage}),
    };
  }).sort((a,b) => (a.remainingMs ?? Infinity) - (b.remainingMs ?? Infinity));
  const active = rows.filter(row => row.band !== 'resolved');
  const departmentCounts = new Map();
  for (const request of visible) {
    if (request.clock.status !== 'resolved' && request.department) departmentCounts.set(request.department, (departmentCounts.get(request.department) || 0) + 1);
  }
  return {
    persona: { id: principal.id, name: principal.name, role: principal.role }, now: instant,
    coverage,
    summary: {
      totalOpen: active.length, overdue: active.filter(row => row.band === 'overdue').length,
      dueSoon: active.filter(row => ['urgent','due_soon'].includes(row.band)).length,
      unassigned: visible.filter(row => !row.ownerId && row.clock.status !== 'resolved').length,
    },
    requests: rows, departments: Array.from(departmentCounts, ([name,waiting]) => ({name,waiting})), audit: [],
  };
}
