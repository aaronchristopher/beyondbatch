import { createRequest } from './domain/response-clock.mjs';

export const demoPrincipals = Object.freeze({
  pm: { id:'avery', name:'Avery · example PM', role:'pm', tenantId:'demo-uniwell', customerIds:['cedar','harbor','meadow','summit'], departmentIds:[] },
  president: { id:'executive', name:'President · example view', role:'president', tenantId:'demo-uniwell', customerIds:['cedar','harbor','meadow','summit'], departmentIds:[] },
  department: { id:'qa-reviewer', name:'QA · example user', role:'department', tenantId:'demo-uniwell', customerIds:['cedar','harbor','meadow','summit'], departmentIds:['qa'] },
});

/** No customer facts. Anchored once per process so countdowns run instead of resetting on refresh. */
export function makeFixtures(now = new Date()) {
  const data = [
    ['r1','cedar','Cedar Nutrition','Release specification needed','avery','Avery','qa','QA',25,'Confirm which specification is approved; give the customer a verified next update time.'],
    ['r2','harbor','Harbor Wellness','Where is the sample shipment?','avery','Avery','warehouse','Warehouse',23,'Check the dispatch record and explain what is confirmed about shipment.'],
    ['r3','meadow','Meadow Health','Revised quote for the next order','jordan','Jordan','purchasing','Purchasing',21,'Confirm ingredient cost and give the customer the expected quote time.'],
    ['r4','summit','Summit Botanicals','Production date confirmation','avery','Avery','production','Production',16,'Ask scheduling to verify the available slot before promising a date.'],
    ['r5','cedar','Cedar Nutrition','Missing certificate of analysis','jordan','Jordan','qa','QA',8,'Find the approved lot certificate and verify it matches the customer’s order.'],
    ['r6','harbor','Harbor Wellness','Clarify sample quantity',null,null,'rd','R&D',2,'Review customer ownership, then confirm the required sample quantity.'],
  ];
  return data.map(([id,customerId,customer,subject,ownerId,owner,departmentId,department,age,nextAction]) => {
    const receivedAt = new Date(+new Date(now) - age*3_600_000).toISOString();
    return {
      id,tenantId:'demo-uniwell',classification:'customer_operations',customerId,customer,subject,ownerId,owner,departmentId,department,nextAction,
      clock:createRequest({id,customerId,subject,ownerId,receivedAt,evidenceId:`fixture-${id}`}),
      operationalEvidenceSummary:'Illustrative incoming request. No verified customer response is recorded. No Microsoft mailbox is connected.',
      rawEmail:'Fixture content must never appear in summary responses.',
    };
  });
}
