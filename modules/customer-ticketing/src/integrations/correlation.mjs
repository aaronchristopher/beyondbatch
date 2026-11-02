import { applyEvent, replayRequest } from '../domain/response-clock.mjs';

/** Pure review-proposal boundary; not a mailbox reader, identity verifier or merge
 * writer. Caller must supply scoped records from trusted storage, never accept
 * request IDs/customer mappings/review approvals from email or model output.
 * Strong headers nominate candidates only: even one candidate requires review.
 * No mailbox copies are deduplicated here; provenance stays with the caller.
 */
const nonempty=(value,label)=>{
 if(typeof value!=='string'||!value.trim()) throw new TypeError(`${label} required`);
 return value;
};
const scoped=(row,tenantId)=>{
 if(!row||row.tenantId!==tenantId) throw new TypeError('tenant scope mismatch');
};
const decision=(status,reason,candidateRequestIds=[])=>({status,reason,candidateRequestIds,reviewRequired:true});
export function proposeCorrelation({tenantId,message,requests,links}) {
 nonempty(tenantId,'tenantId'); scoped(message,tenantId); nonempty(message.id,'message.id');
 if(!Array.isArray(requests)||!Array.isArray(links)) throw new TypeError('scoped records required');
 for(const row of [...requests,...links]) scoped(row,tenantId);
 if(!message.customerId) return decision('needs_review','unknown_customer');
 const byId=new Map();
 for(const request of requests){
  nonempty(request.id,'request.id');
  if(byId.has(request.id)) throw new TypeError('duplicate request record');
  byId.set(request.id,request);
 }
 const matched=links.filter(link=>link.messageId===message.id ||
  (typeof message.inReplyTo==='string'&&message.inReplyTo.trim()&&link.internetMessageId===message.inReplyTo));
 if(!matched.length) return decision('needs_review','no_strong_link');
 const candidates=[];
 for(const link of matched){
  const request=byId.get(link.requestId);
  if(!request) return decision('needs_review','unavailable_request');
  if(link.customerId!==message.customerId||request.customerId!==message.customerId)
   return decision('needs_review','conflicting_customer');
  for(const key of ['productId','purchaseOrderId']) {
   if(message[key]!=null&&request[key]!=null&&message[key]!==request[key])
    return decision('needs_review','conflicting_entities');
  }
  candidates.push(request.id);
 }
 const ids=[...new Set(candidates)].sort();
 return decision(ids.length===1?'candidate':'needs_review',ids.length===1?'strong_link':'ambiguous_links',ids);
}

/** Produce a reducer-compatible event plus review audit metadata, never commit it.
 * `review` must be loaded from an authenticated authorized human review record.
 * `message` must be an observed Sent Items copy with verified customer recipient
 * mapping. Sent proves submission, not delivery or customer receipt. Later bounce
 * reconciliation is a separate required integration; never drop bounce evidence.
 * Only explicitly reviewed pending inbound obligations are covered, never all
 * asks inferred from threading, model confidence, or a generic acknowledgment.
 */
export function reviewedSentResponse({tenantId,request,message,review,eventId}) {
 nonempty(tenantId,'tenantId');
 for(const row of [request,message,review]) scoped(row,tenantId);
 nonempty(eventId,'eventId'); nonempty(message.id,'message.id');
 if(review.requestId!==request.id||review.messageId!==message.id) throw new TypeError('review binding mismatch');
 nonempty(review.reviewerId,'reviewerId'); nonempty(review.evidenceId,'review evidence');
 if(review.meaningful!==true) throw new TypeError('meaningful response review required');
 if(message.direction!=='outbound'||message.sourceFolder!=='sent'||message.deliveryState!=='sent'||message.isDraft!==false)
  throw new TypeError('observed non-draft Sent evidence required');
 if(message.recipientVerified!==true||message.recipientCustomerId!==request.customerId||message.customerId!==request.customerId)
  throw new TypeError('verified customer recipient required');
 nonempty(message.recipientEvidenceId,'recipient evidence');
 const state=replayRequest(request);
 const ids=review.addressedObligationIds;
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length) throw new TypeError('explicit distinct coverage required');
 const pending=new Set(state.responseObligations.filter(o=>o.outcome==='pending'&&o.kind!=='recurring').map(o=>o.id));
 if(ids.some(id=>!pending.has(id))) throw new TypeError('coverage must name pending inbound obligations');
 const event={id:eventId,type:'response_sent',evidenceId:message.id,sentAt:message.sentAt,
  meaningful:true,customerFacing:true,recipientVerified:true,recipientEvidenceId:message.recipientEvidenceId,
  messageKind:'response',deliveryState:'sent',direction:'outbound',coversAllOutstandingAsks:false,
  addressedObligationIds:[...ids].sort()};
 // Exercise the existing domain boundary now, including timestamp/coverage rules.
 applyEvent(state,event);
 return {event,audit:{reviewerId:review.reviewerId,reviewEvidenceId:review.evidenceId,
  messageId:message.id,requestId:request.id,tenantId,deliveryConfirmed:false}};
}
