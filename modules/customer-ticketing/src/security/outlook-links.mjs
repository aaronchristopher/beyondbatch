/** Accept an observed Graph webLink, never a model-generated URL or a mailto composition. */
export function validatedOutlookWebLink(value) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !['outlook.office.com','outlook.office365.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.hash) return null;
  // Initial supported form is Microsoft's documented Graph message webLink.
  // Unknown forms go to review instead of guessing a message or redirect target.
  if (url.pathname !== '/owa/' && url.pathname !== '/owa') return null;
  const allowed = new Set(['ItemID','exvsurl','viewmodel','ispopout']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  if (!url.searchParams.get('ItemID')?.trim() || url.searchParams.get('viewmodel') !== 'ReadMessageItem') return null;
  if (url.searchParams.has('exvsurl') && url.searchParams.get('exvsurl') !== '1') return null;
  if (url.searchParams.has('ispopout') && !['0','1'].includes(url.searchParams.get('ispopout'))) return null;
  return value;
}

/** Called only after request authorization. Source ACLs are stricter than request-summary scope. */
export function projectOutlookAction({principal,request,coverage}) {
  const base={label:'Reply in Outlook',channel:null};
  if (coverage?.mode === 'fictional') return {...base,status:'not_connected',reason:'Connect Outlook to use this'};
  const source=request.replySource;
  const unavailable=()=>({...base,status:'unavailable',reason:'An accessible customer email must be linked first'});
  if (!principal || request.tenantId !== principal.tenantId || request.classification !== 'customer_operations') return unavailable();
  if (!source || source.tenantId !== request.tenantId || source.requestId !== request.id
      || source.provenance !== 'microsoft_graph' || source.selectionStatus !== 'verified'
      || source.purpose !== 'customer_reply' || source.direction !== 'inbound' || source.isDraft !== false
      || typeof source.messageId !== 'string' || !source.messageId.trim()
      || typeof source.mailboxId !== 'string' || !source.mailboxId.trim()) return unavailable();
  // These scopes are loaded/rechecked server-side for the signed-in user.
  // Reading an operational roll-up or ingesting the mailbox never implies source access.
  if (!Array.isArray(principal.outlookMailboxIds) || !principal.outlookMailboxIds.includes(source.mailboxId)
      || !Array.isArray(source.readableByPrincipalIds) || !source.readableByPrincipalIds.includes(principal.id)) return unavailable();
  const href=validatedOutlookWebLink(source.webLink);
  if (!href) return unavailable();
  return {...base,status:'ready',channel:'web',href,
    reason:'Opens the original email in Outlook on the web. Use Reply or Reply All there.'};
}
