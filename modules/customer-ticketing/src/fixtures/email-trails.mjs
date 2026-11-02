import { canReadRequest } from '../security/workspace.mjs';

// Fictional conversations for interface review only. Never populate this module
// with mailbox exports or reuse it as a production evidence authorization path.
const pm = { name: 'Avery · example PM', address: 'avery@manufacturer.example' };
const jordan = { name: 'Jordan · example PM', address: 'jordan@manufacturer.example' };
const team = { name: 'Project team · example', address: 'projects@manufacturer.example' };
const qa = { name: 'Quality team · example', address: 'quality@manufacturer.example' };
const warehouse = { name: 'Warehouse team · example', address: 'warehouse@manufacturer.example' };
const buyer = { name: 'Purchasing team · example', address: 'purchasing@manufacturer.example' };
const scheduling = { name: 'Scheduling team · example', address: 'scheduling@manufacturer.example' };
const research = { name: 'R&D team · example', address: 'research@manufacturer.example' };
const cedar = { name: 'Morgan · example customer', address: 'morgan@cedar.example' };
const harbor = { name: 'Riley · example customer', address: 'riley@harbor.example' };
const meadow = { name: 'Taylor · example customer', address: 'taylor@meadow.example' };
const summit = { name: 'Casey · example customer', address: 'casey@summit.example' };

const message = (hours, direction, from, to, body, attachments = []) => ({ hours, direction, from, to, body, attachments });
const examples = {
  r1: { customerId: 'cedar', threads: [
    { subject: 'Release specification for the next order', messages: [
      message(0, 'incoming', cedar, [pm.address], 'Hi Avery,\n\nCould you send the approved release specification for our next order? We have two revisions on file and need to confirm which one our team should use.\n\nPlease include the approved revision number.\n\nThank you,\nMorgan'),
      message(0.5, 'internal', pm, [qa.address], 'Quality team,\n\nCedar needs the approved release specification. Please confirm the current controlled revision and share the approved file. I will respond to the customer once we have that confirmation.\n\nAvery'),
    ] },
    { subject: 'QA review — Cedar specification revision', messages: [
      message(3, 'internal', qa, [pm.address], 'Avery,\n\nWe found both revisions in the review folder. The document owner is checking the approval record. Please hold the customer-facing specification until that check is complete.\n\nQuality team', [{ name: 'Specification-review-notes.example.pdf' }]),
      message(4, 'internal', pm, [qa.address], 'Thanks. Please confirm the approved revision and when the controlled file will be available. The customer is still waiting for our answer.\n\nAvery'),
    ] },
  ] },
  r2: { customerId: 'harbor', threads: [
    { subject: 'Tracking for our sample shipment', messages: [
      message(0, 'incoming', harbor, [pm.address], 'Hi Avery,\n\nCan you confirm whether the samples have shipped and send the tracking details? Our team is arranging its evaluation and needs an expected arrival date.\n\nThanks,\nRiley'),
      message(0.5, 'internal', pm, [warehouse.address], 'Warehouse team,\n\nCould you check the dispatch record for Harbor’s samples and confirm the carrier, tracking and expected arrival? Please distinguish a created label from a shipment actually handed to the carrier.\n\nAvery'),
      message(2, 'internal', warehouse, [pm.address], 'Avery,\n\nWe are checking the handoff record. A label exists, but we have not yet verified carrier collection. We will confirm the actual shipment status.\n\nWarehouse team'),
    ] },
  ] },
  r3: { customerId: 'meadow', threads: [
    { subject: 'Updated pricing for the next production order', messages: [
      message(0, 'incoming', meadow, [jordan.address], 'Hi Jordan,\n\nPlease send an updated quote for our next order using the revised ingredient cost. We need the price and any change to the minimum order quantity before moving ahead.\n\nThank you,\nTaylor'),
      message(1, 'internal', jordan, [buyer.address], 'Purchasing team,\n\nMeadow needs a revised quote. Please confirm the current ingredient cost, supplier minimum and validity period so I can update the customer’s pricing.\n\nJordan'),
      message(3, 'internal', buyer, [jordan.address], 'Jordan,\n\nThe supplier has been asked to confirm the current price and minimum. The previous price should not be treated as a confirmed quote. We are waiting for the written update.\n\nPurchasing team'),
    ] },
  ] },
  r4: { customerId: 'summit', threads: [
    { subject: 'Can you confirm our production date?', messages: [
      message(0, 'incoming', summit, [pm.address], 'Hi Avery,\n\nCould you confirm the production date for our next run? We are coordinating the launch and need a date we can plan against.\n\nThanks,\nCasey'),
      message(1, 'internal', pm, [scheduling.address], 'Scheduling team,\n\nSummit needs a production date. Please verify the available slot and any material or approval constraints before we make a commitment.\n\nAvery'),
      message(2, 'internal', scheduling, [pm.address], 'Avery,\n\nThere is a tentative slot under review. Material readiness still needs confirmation, so this is not a committed date yet. We are checking the constraint with production.\n\nScheduling team'),
    ] },
  ] },
  r5: { customerId: 'cedar', threads: [
    { subject: 'COA missing from the document package', messages: [
      message(0, 'incoming', cedar, [jordan.address], 'Hi Jordan,\n\nThe document package is missing the certificate of analysis for the lot on our order. Could you send the approved COA and confirm that the lot reference matches?\n\nThank you,\nMorgan'),
      message(0.5, 'internal', jordan, [qa.address], 'Quality team,\n\nPlease locate the approved COA for Cedar’s order and verify the lot reference. I need the released document before responding to the customer.\n\nJordan'),
      message(2, 'internal', qa, [jordan.address], 'Jordan,\n\nWe found a candidate certificate and are checking its release status and lot reference. Please do not forward the working copy as an approved COA.\n\nQuality team'),
    ] },
  ] },
  r6: { customerId: 'harbor', threads: [
    { subject: 'Sample quantity for the evaluation', messages: [
      message(0, 'incoming', harbor, [team.address], 'Hello project team,\n\nFor our evaluation, can you confirm whether we should expect 10 samples or 24? We have seen both quantities mentioned and need to align the evaluation plan.\n\nThanks,\nRiley'),
      message(0.25, 'internal', team, [research.address], 'R&D team,\n\nHarbor is asking which sample quantity is correct. Please check the sample request and confirm the intended quantity. Account ownership also needs review before assigning the customer response.\n\nProject team'),
      message(0.5, 'internal', research, [team.address], 'Project team,\n\nWe are comparing the two sample requests. We have not confirmed a final quantity yet.\n\nR&D team'),
    ] },
  ] },
};

export function getDemoEmailTrail({ request, principal }) {
  if (!request || request.fixtureSource !== 'fictional-email-trail-v1' || request.tenantId !== 'demo-uniwell') return null;
  if (!Object.hasOwn(examples, request.id) || examples[request.id].customerId !== request.customerId || !canReadRequest(principal, request)) return null;
  const receivedAt = Date.parse(request.clock?.receivedAt);
  if (!Number.isFinite(receivedAt)) return null;
  return {
    mode: 'fictional', requestId: request.id, customer: request.customer, task: request.subject,
    threads: examples[request.id].threads.map((thread, index) => ({
      id: `${request.id}-thread-${index + 1}`, subject: thread.subject,
      messages: thread.messages.map((item, messageIndex) => ({
        id: `${request.id}-thread-${index + 1}-message-${messageIndex + 1}`,
        from: { ...item.from }, to: [...item.to],
        sentAt: new Date(receivedAt + item.hours * 3_600_000).toISOString(),
        direction: item.direction, body: item.body, attachments: item.attachments.map(attachment => ({ ...attachment })),
      })),
    })),
  };
}

export function demoEmailSubject(requestId) {
  return Object.hasOwn(examples, requestId) ? examples[requestId].threads[0].subject : undefined;
}
