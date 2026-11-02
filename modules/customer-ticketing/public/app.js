const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = String(text);
  return node;
};
const view = {
  persona: 'pm', data: null, search: '', department: '', loading: false,
  windows: new Map(), z: 10, focusKey: null, fetchSequence: 0, loadedAt: 0, awaitingOpen: false
};
const HOUR = 60 * 60 * 1000;
const narrow = () => matchMedia('(max-width: 700px)').matches;
const valueText = (value, fallback = 'Not recorded') => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(item => valueText(item, '')).filter(Boolean).join('\n');
  return valueText(value.name ?? value.summary ?? value.text, fallback);
};
const formatDate = (value, options = {}) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...options
  }).format(new Date(value));
};
function announce(message) { $('#announcer').textContent = ''; requestAnimationFrame(() => { $('#announcer').textContent = message; }); }
function icon(name, className = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true');
  if (className) node.setAttribute('class', className);
  const paths = {
    close: 'M6 6l12 12M18 6 6 18',
    move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
    grip: 'M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01'
  };
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.close); node.append(path); return node;
}
function button(label, className, handler) {
  const node = el('button', className, label); node.type = 'button';
  if (handler) node.addEventListener('click', handler); return node;
}
function remaining(request) {
  if (['resolved', 'waiting_on_customer', 'waiting_customer'].includes(String(request.status))) return null;
  if (Number.isFinite(request.remainingMs)) return request.remainingMs - Math.max(0, performance.now() - view.loadedAt);
  if (!request.dueAt) return null;
  const due = new Date(request.dueAt).getTime(); const now = previewNow();
  return Number.isFinite(due) && Number.isFinite(now) ? due - now : null;
}
function previewNow() { return new Date(view.data?.now).getTime() + Math.max(0, performance.now() - view.loadedAt); }
function waitingOnCustomer(request) { return ['waiting_on_customer', 'waiting_customer'].includes(String(request.status)) || request.band === 'waiting_customer'; }
function band(request) {
  const ms = remaining(request);
  if (ms !== null) {
    if (ms <= 0) return 'overdue';
    if (ms <= 2 * HOUR) return 'soon';
    const day = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
    if (request.dueAt && view.data?.now && day(request.dueAt) === day(previewNow())) return 'today';
    return 'track';
  }
  const raw = String(request.band || '').toLowerCase();
  if (raw.includes('overdue')) return 'overdue';
  if (raw.includes('soon') || raw.includes('next')) return 'soon';
  if (raw.includes('today')) return 'today';
  return 'track';
}
function duration(ms) {
  const minutes = Math.max(1, Math.ceil(Math.abs(ms) / 60000));
  const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  return hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${minutes}m`;
}
function timerText(request) {
  const ms = remaining(request);
  if (ms === null && ['waiting_on_customer', 'waiting_customer'].includes(String(request.status))) return 'With customer';
  if (ms === null) return 'Timing needs review';
  if (ms <= 0) return `${duration(ms)} overdue`;
  return `${duration(ms)} left`;
}
function timer(request) { const node = el('span', `response-timer is-${band(request)}`, timerText(request)); node.dataset.responseClock = String(request.id); return node; }
function statusText(request) {
  const status = valueText(request.status, 'Open request');
  return status.replaceAll('_', ' ').replaceAll('-', ' ').replace(/^\w/, letter => letter.toUpperCase());
}
function filteredRequests() {
  return (view.data?.requests || []).filter(request => {
    if (request.band === 'resolved' || request.status === 'resolved') return false;
    const searchable = [request.customer, request.subject, request.owner, request.department, request.nextAction].map(v => valueText(v, '')).join(' ').toLowerCase();
    return (!view.search || searchable.includes(view.search)) && (!view.department || valueText(request.department) === view.department);
  }).sort((a, b) => (remaining(a) ?? Infinity) - (remaining(b) ?? Infinity));
}
async function loadWorkspace(persona = view.persona) {
  const sequence = ++view.fetchSequence;
  view.loading = true; document.body.classList.add('loading');
  $('#refresh-button').disabled = true;
  closeAllWindows(); view.data = null;
  $('#summary-strip').replaceChildren(el('span', 'summary-label', 'Loading the selected demo view…'));
  $('#coverage-text').textContent = 'Loading fictional workspace…'; $('#as-of').textContent = '';
  view.persona = persona;
  document.querySelectorAll('[data-persona]').forEach(node => {
    const active = node.dataset.persona === persona; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active));
  });
  renderLoading();
  try {
    const response = await fetch(`/api/workspace?persona=${encodeURIComponent(persona)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Workspace returned ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.requests) || !data.coverage || !data.persona) throw new Error('The workspace response is incomplete.');
    if (sequence !== view.fetchSequence) return;
    view.data = data; view.loadedAt = performance.now(); closeAllWindows(); renderWorkspace();
    announce(`${persona === 'president' ? 'President demo' : persona === 'department' ? 'QA queue demo' : 'My work demo'} loaded. ${data.requests.length} visible requests.`);
  } catch (error) {
    if (sequence !== view.fetchSequence) return;
    view.data = null; closeAllWindows(); $('#summary-strip').replaceChildren();
    const empty = el('div', 'workspace-empty'); empty.append(el('h3', '', 'The workspace could not load'), el('p', '', 'The local development API did not return the workspace. Check that the demo server is running, then try again.'), button('Try again', 'primary-button', () => loadWorkspace()));
    $('#workspace-content').replaceChildren(empty); $('#coverage-text').textContent = 'Workspace unavailable · no email connection'; $('#as-of').textContent = '';
    announce('The workspace could not load. Try again is available.');
  } finally {
    if (sequence === view.fetchSequence) { view.loading = false; document.body.classList.remove('loading'); $('#refresh-button').disabled = false; }
  }
}
function renderLoading() {
  const skeleton = el('div', 'skeleton-board'); skeleton.setAttribute('aria-label', 'Loading workspace');
  for (let i = 0; i < 4; i++) skeleton.append(el('div', 'skeleton-lane'));
  $('#workspace-content').replaceChildren(skeleton);
}
function renderWorkspace() {
  const president = view.persona === 'president';
  const department = view.persona === 'department';
  $('#page-title').textContent = president ? 'What customers are waiting on' : department ? 'QA’s next customer answers' : 'Your response clock';
  $('#page-description').textContent = president ? 'The next answer, its accountable owner, and what needs to move.' : department ? 'The inputs QA owes. The PM still owns the customer’s answer.' : 'A meaningful answer within 24 hours. A clear next step until it’s resolved.';
  $('#workspace-title').textContent = president ? 'Customer overview' : department ? 'QA dependencies' : 'Response workspace';
  renderSummary();
  const select = $('#department-filter'); const options = [el('option', '', 'All departments')]; options[0].value = '';
  const names = [...new Set(view.data.requests.map(r => valueText(r.department, '')).filter(Boolean))].sort();
  for (const name of names) { const option = el('option', '', name); option.value = name; options.push(option); }
  select.replaceChildren(...options); if (!names.includes(view.department)) view.department = ''; select.value = view.department;
  $('#coverage-text').textContent = `${valueText(view.data.coverage.status, 'Demo only')} · ${valueText(view.data.coverage.detail, 'Fictional requests. Microsoft email is not connected.')}`;
  $('#as-of').textContent = `Timing from last load · ${formatDate(view.data.now)} Central`;
  renderContent();
}
function renderSummary() {
  const summary = view.data.summary || {};
  const active = view.data.requests.filter(r => r.status !== 'resolved' && r.band !== 'resolved');
  const entries = [
    ['Open requests', summary.totalOpen ?? view.data.requests.length, ''],
    ['Overdue', active.filter(r => !waitingOnCustomer(r) && band(r) === 'overdue').length, 'is-urgent'],
    ['Due in 2 hours', active.filter(r => !waitingOnCustomer(r) && band(r) === 'soon').length, 'is-soon'],
    ['Need an owner', summary.unassigned ?? 0, 'is-quiet']
  ];
  $('#summary-strip').replaceChildren(...entries.map(([label, count, extra]) => { const stat = el('div', `summary-stat ${extra}`); stat.append(el('span', 'summary-value', count), el('span', 'summary-label', label)); return stat; }));
}
function renderContent() {
  if (!view.data) return;
  const requests = filteredRequests();
  if (!requests.length) {
    const empty = el('div', 'workspace-empty'); empty.append(el('h3', '', 'No requests in this view'), el('p', '', view.search || view.department ? 'Try a different customer, request or department.' : 'No open requests are included in this fictional workspace.'));
    if (view.search || view.department) empty.append(button('Clear filters', 'secondary-button', () => { view.search = ''; view.department = ''; $('#search').value = ''; $('#department-filter').value = ''; renderContent(); }));
    $('#workspace-content').replaceChildren(empty); return;
  }
  if (view.persona === 'president') renderPresident(requests); else renderBoard(requests);
}
function renderBoard(requests) {
  const board = el('div', 'priority-board');
  const waiting = requests.filter(waitingOnCustomer);
  const active = requests.filter(request => !waitingOnCustomer(request));
  const definitions = [
    ['overdue', 'Overdue', 'No overdue answers.', 'Keep the next update moving.'],
    ['soon', 'Next 2 hours', 'A little breathing room.', 'Nothing is due in the next two hours.'],
    ['today', 'Today', 'Today is covered.', 'No other answers are due today.'],
    ['track', 'On track', 'Nothing further ahead.', 'New requests will appear here.']
  ];
  for (const [key, label, emptyTitle, emptyText] of definitions) {
    const lane = el('section', 'lane'); lane.dataset.band = key; lane.setAttribute('aria-label', label);
    const items = active.filter(request => band(request) === key);
    const heading = el('div', 'lane-header'); const title = el('h3', 'lane-title'); title.append(el('span', 'lane-marker'), document.createTextNode(label)); heading.append(title, el('span', 'lane-count', items.length)); lane.append(heading);
    for (const request of items) lane.append(requestCard(request));
    if (!items.length) { const empty = el('p', 'lane-empty'); empty.append(el('strong', '', emptyTitle), document.createTextNode(emptyText)); lane.append(empty); }
    board.append(lane);
  }
  const content = [board];
  if (waiting.length) {
    const details = el('details', 'awaiting-customer'); details.open = view.awaitingOpen;
    details.append(el('summary', '', `Waiting on customers · ${waiting.length}`));
    details.append(el('p', 'awaiting-note', 'These requests remain open. No response countdown is currently owed by UniWell.'));
    const list = el('div', 'awaiting-list'); waiting.forEach(request => list.append(requestCard(request))); details.append(list);
    details.addEventListener('toggle', () => { view.awaitingOpen = details.open; }); content.push(details);
  }
  $('#workspace-content').replaceChildren(...content);
}
function requestCard(request) {
  const card = button('', 'request-item', () => openRequest(request)); card.dataset.request = String(request.id);
  card.setAttribute('aria-label', `${valueText(request.customer)}: ${valueText(request.subject)}. ${timerText(request)}. Open request.`);
  card.setAttribute('aria-expanded', String(view.windows.has(`request:${request.id}`)));
  const top = el('span', 'request-item-top'); top.append(el('span', 'request-customer', valueText(request.customer)), timer(request));
  const bottom = el('span', 'request-item-bottom'); const owner = el('span', 'request-owner'); const name = valueText(request.owner, 'Needs owner'); owner.append(el('span', 'avatar', name[0]?.toUpperCase() || '?'), document.createTextNode(name)); bottom.append(owner, el('span', 'department-tag', valueText(request.department, 'Needs routing')));
  card.append(top, el('span', 'request-subject', valueText(request.subject)), el('span', 'request-next', valueText(request.nextAction, 'Confirm the next action.')), bottom); return card;
}
function customerGroups(requests) {
  const groups = new Map();
  for (const request of requests) { const name = valueText(request.customer, 'Customer needs review'); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(request); }
  return [...groups].sort((a, b) => Math.min(...a[1].map(r => remaining(r) ?? Infinity)) - Math.min(...b[1].map(r => remaining(r) ?? Infinity)));
}
function renderPresident(requests) {
  const wrapper = el('div', 'president-report'); const table = el('table', 'customer-report'); table.setAttribute('aria-label', 'Customer response overview');
  const head = el('thead'); const row = el('tr'); ['Customer', 'Open', 'Next answer', 'What needs to move', 'Accountable PM'].forEach(text => { const cell = el('th', '', text); cell.scope = 'col'; row.append(cell); }); head.append(row); const body = el('tbody');
  for (const [customer, items] of customerGroups(requests)) {
    const first = items[0]; const tr = el('tr');
    const name = el('td'); const customerButton = button(customer, 'customer-name-button', () => openCustomer(customer, items)); customerButton.dataset.customer = customer; name.append(customerButton);
    const overdue = items.filter(r => band(r) === 'overdue').length; name.append(el('span', 'customer-meta', overdue ? `${overdue} ${overdue === 1 ? 'answer' : 'answers'} overdue` : 'No overdue answers'));
    const count = el('td'); count.append(el('span', 'customer-count', items.length));
    const clock = el('td'); clock.append(timer(first), el('span', 'customer-meta', `${formatDate(first.dueAt)} Central`));
    const blocker = el('td'); const blockText = el('p', 'customer-blocker', valueText(first.department, 'Ownership review')); blockText.append(el('small', '', valueText(first.nextAction, 'Confirm next action.'))); blocker.append(blockText);
    const owner = el('td', '', [...new Set(items.map(r => valueText(r.owner, 'Needs owner')))].join(', '));
    tr.append(name, count, clock, blocker, owner); body.append(tr);
  }
  table.append(head, body); wrapper.append(table, el('p', 'report-note', 'Customer status and dependencies only. Private email bodies are not included in this president view.'));
  $('#workspace-content').replaceChildren(wrapper);
}
function openCustomer(customer, requests) {
  const window = createWindow(`customer:${customer}`, customer, 'Customer overview'); if (!window.isNew) return;
  window.body.append(el('h2', '', customer), el('p', 'window-context', `${requests.length} open ${requests.length === 1 ? 'request' : 'requests'} · demo customer`));
  const list = el('div', 'customer-request-list');
  for (const request of requests) {
    const item = button('', 'customer-request-button', () => openRequest(request)); const copy = el('span'); copy.append(el('strong', '', valueText(request.subject)), el('small', '', `${valueText(request.owner, 'Needs owner')} · ${valueText(request.department, 'Needs routing')}`)); item.append(copy, timer(request)); list.append(item);
  }
  window.body.append(list);
}
function addFact(list, label, value) { const cell = el('div'); cell.append(el('dt', '', label), el('dd', '', valueText(value))); list.append(cell); }
let outlookActionSequence = 0;
function safeOutlookMessageHref(href) {
  if (typeof href !== 'string' || href.length > 8192 || href !== href.trim() || /[\u0000-\u0020\u007f\\]/u.test(href)) return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'https:' || !['outlook.office.com', 'outlook.office365.com'].includes(url.hostname) || url.username || url.password || url.port || url.hash) return null;
  if (url.pathname !== '/owa/' && url.pathname !== '/owa') return null;
  const allowed = new Set(['ItemID', 'exvsurl', 'viewmodel', 'ispopout']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  if (!url.searchParams.get('ItemID')?.trim() || url.searchParams.get('viewmodel') !== 'ReadMessageItem') return null;
  if (url.searchParams.has('exvsurl') && url.searchParams.get('exvsurl') !== '1') return null;
  if (url.searchParams.has('ispopout') && !['0', '1'].includes(url.searchParams.get('ispopout'))) return null;
  return href;
}
function createOutlookAction(request) {
  const supplied = request.outlookAction;
  const href = supplied?.status === 'ready' && supplied.channel === 'web' ? safeOutlookMessageHref(supplied.href) : null;
  if (view.persona !== 'pm' && !href) return null;
  const note = el('p', 'outlook-action-note'); note.id = `outlook-action-note-${++outlookActionSequence}`;
  let control;
  if (href) {
    control = el('a', 'primary-button outlook-link', 'Reply in Outlook');
    control.setAttribute('href', href); control.target = '_blank'; control.rel = 'noopener noreferrer'; control.referrerPolicy = 'no-referrer';
    note.textContent = 'Opens the original email in Outlook on the web. Use Reply or Reply all there. Opening directly in Classic Outlook for Windows requires a desktop integration.';
  } else {
    const status = supplied?.status === 'not_connected' || !supplied ? 'not_connected' : 'unavailable';
    const reason = supplied?.status === 'ready'
      ? 'A verified link to the original email is not available for this request.'
      : valueText(supplied?.reason, status === 'not_connected' ? 'Microsoft email is not connected. An approved mailbox connection is needed before the original email can be opened.' : 'The original email is not available in your current request view.');
    control = button('Reply in Outlook', 'primary-button', () => openOutlookConnection(request, status, reason));
    note.textContent = status === 'not_connected' ? 'Connect Outlook to use this' : 'Original email link unavailable · view details';
  }
  control.setAttribute('aria-describedby', note.id);
  return { control, note };
}
function openOutlookConnection(request, status, reason) {
  const key = `outlook:${request.id}`;
  const window = createWindow(key, valueText(request.customer), 'Outlook connection'); if (!window.isNew) return;
  window.body.append(el('h2', '', status === 'not_connected' ? 'Outlook is not connected' : 'The original email is unavailable'), el('p', 'window-context', valueText(request.subject)), el('p', 'evidence-summary', reason));
  window.body.append(el('h3', 'section-title', 'Reply in the original conversation'), el('p', 'evidence-summary', 'With an approved mailbox connection and access to the source email, Reply in Outlook opens that original email in Outlook on the web. Use Reply or Reply all there.'));
  window.body.append(el('p', 'outlook-platform-note', 'Opening directly in Classic Outlook for Windows requires a desktop integration. The verified standard link opens Outlook on the web.'), el('p', 'history-note', 'Opening an email does not mark this request answered or change its response clock. A meaningful sent reply must be verified.'));
  window.actions.append(button('Back to the request', 'secondary-button', () => closeWindow(key)));
}
function openRequest(request) {
  const window = createWindow(`request:${request.id}`, valueText(request.customer), 'Request'); if (!window.isNew) return;
  window.body.append(el('h2', '', valueText(request.subject)), el('p', 'window-context', valueText(request.customer)));
  const state = el('div', 'window-status'); state.append(timer(request), el('span', 'status-divider', '·'), el('span', '', statusText(request))); window.body.append(state);
  const facts = el('dl', 'window-facts'); addFact(facts, 'Accountable PM', valueText(request.owner, 'Needs owner')); addFact(facts, 'Waiting on', valueText(request.department, 'Needs routing')); addFact(facts, 'Meaningful response due', `${formatDate(request.dueAt)} Central`); addFact(facts, 'Last meaningful response', request.lastMeaningfulResponseAt ? `${formatDate(request.lastMeaningfulResponseAt)} Central` : 'None recorded'); window.body.append(facts);
  window.body.append(el('h3', 'section-title', 'What moves this forward'), el('p', 'next-action', valueText(request.nextAction, 'Confirm the next action with the accountable owner.')));
  if (view.persona !== 'president') window.body.append(el('h3', 'section-title', 'What the record shows'), el('p', 'evidence-summary', valueText(request.evidenceSummary, 'No evidence summary is included in this fixture.')));
  else window.body.append(el('p', 'history-note', 'This view shows the customer commitment and dependency. Private source email is not available here.'));
  const actions = el('div', 'window-actions-group'); actions.append(button('Review history', 'secondary-button', () => openHistory(request)));
  if (view.persona === 'pm') actions.append(button('Preview update', 'secondary-button', () => openDraft(request)));
  const outlook = createOutlookAction(request);
  if (outlook) {
    actions.append(outlook.control); actions.classList.add('outlook-actions-group');
    window.actions.append(actions, outlook.note);
  } else window.actions.append(el('p', 'desktop-hint', 'Keep context. Open another window.'), actions);
  syncExpandedCards();
}
function openHistory(request) {
  const window = createWindow(`history:${request.id}`, valueText(request.customer), 'Response history'); if (!window.isNew) return;
  window.body.append(el('h2', '', 'Response history'), el('p', 'window-context', valueText(request.subject)));
  const events = [
    { title: 'Request received', time: request.receivedAt, body: 'The response obligation begins from the recorded request time.' },
    ...(request.lastMeaningfulResponseAt ? [{ title: 'Meaningful response recorded', time: request.lastMeaningfulResponseAt, body: 'This is the latest substantive customer-facing response in the fixture.' }] : []),
    { title: 'Current response deadline', time: request.dueAt, body: 'A meaningful response is required. Acknowledgments, drafts and internal updates do not satisfy the clock.' }
  ];
  const list = el('ol', 'timeline');
  for (const event of events) { const item = el('li'); item.append(el('h3', 'timeline-title', event.title), el('p', 'timeline-time', `${formatDate(event.time)} Central`), el('p', 'timeline-body', event.body)); list.append(item); }
  window.body.append(list);
  if (view.persona !== 'president') window.body.append(el('h3', 'section-title', 'Evidence summary'), el('p', 'evidence-summary', valueText(request.evidenceSummary, 'No additional source evidence is included.')));
  window.body.append(el('p', 'history-note', 'This local preview shows fixture timing and permitted summaries. It does not open or fetch real email.'));
}
function openDraft(request) {
  if (view.persona !== 'pm') return;
  const window = createWindow(`draft:${request.id}`, valueText(request.customer), 'Update preview'); if (!window.isNew) return;
  window.body.append(el('h2', '', 'Prepare a useful update'), el('p', 'window-context', valueText(request.subject)), el('p', 'evidence-summary', `Next action: ${valueText(request.nextAction, 'Confirm the next action.')}`));
  const label = el('label', 'draft-label', 'Draft starting point'); const area = el('textarea', 'draft-textarea'); const fieldId = `draft-field-${view.windows.size}`; area.id = fieldId; label.htmlFor = fieldId;
  area.value = `Hello,\n\nI’m following up on your request about ${valueText(request.subject, 'the outstanding request')}.\n\n[Add the confirmed answer or specific progress supported by the evidence.]\n\n[Confirm what happens next and give a supported time for the next update.]\n\n${valueText(request.owner, 'Your project manager')}`;
  const note = el('p', 'draft-note'); note.append(el('strong', '', 'No message will be sent. '), document.createTextNode('This editable starting point is not a meaningful response until you add a factual answer or substantive progress. It does not change the response clock.'));
  window.body.append(label, area, note);
  const copy = button('Copy draft text', 'secondary-button', async () => {
    try { await navigator.clipboard.writeText(area.value); copy.textContent = 'Copied'; announce('Draft text copied. No message was sent.'); setTimeout(() => { if (copy.isConnected) copy.textContent = 'Copy draft text'; }, 2200); }
    catch { area.focus(); area.select(); announce('Copy is unavailable here. The draft text is selected so you can copy it manually.'); }
  });
  const actions = el('div', 'window-actions-group outlook-actions-group'); actions.append(copy);
  const outlook = createOutlookAction(request);
  if (outlook) { actions.append(outlook.control); window.actions.append(actions, outlook.note); }
  else window.actions.append(el('p', 'desktop-hint', 'Local text only · not saved to Outlook'), actions);
}
function createWindow(key, context, type) {
  const existing = view.windows.get(key);
  if (existing) { focusWindow(key, true); return { ...existing, isNew: false }; }
  const opener = document.activeElement;
  const frame = el('section', 'app-window'); frame.tabIndex = -1; frame.setAttribute('role', 'dialog'); frame.setAttribute('aria-modal', 'false'); frame.setAttribute('aria-label', `${type}: ${context}`); frame.dataset.windowKey = key;
  const bar = el('div', 'window-titlebar'); bar.append(icon('grip', 'window-grip'), el('span', 'window-title', `${type} · ${context}`));
  const controls = el('div', 'window-controls'); const move = button('', 'window-control'); move.dataset.action = 'move'; move.setAttribute('aria-label', 'Move window with arrow keys'); move.setAttribute('aria-pressed', 'false'); move.title = 'Move window · arrow keys'; move.append(icon('move'));
  const close = button('', 'window-control', () => closeWindow(key)); close.setAttribute('aria-label', `Close ${type.toLowerCase()}`); close.title = 'Close window · Escape'; close.append(icon('close')); controls.append(move, close); bar.append(controls);
  const help = el('p', 'move-instructions', 'Use arrow keys to move this window. Hold Shift for a larger move. Press Enter to finish.'); help.hidden = true;
  const body = el('div', 'window-body'); const actions = el('div', 'window-actions'); frame.append(bar, help, body, actions);
  const offset = view.windows.size % 4; const item = { key, frame, body, actions, bar, move, help, opener, x: 26 + offset * 32, y: 22 + offset * 25, context, type };
  view.windows.set(key, item); $('#window-layer').append(frame); positionWindow(item); setupDrag(item);
  frame.addEventListener('pointerdown', () => focusWindow(key, false)); frame.addEventListener('focusin', () => focusWindow(key, false));
  frame.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeWindow(key); } });
  move.addEventListener('click', () => { const active = move.getAttribute('aria-pressed') !== 'true'; move.setAttribute('aria-pressed', String(active)); help.hidden = !active; if (active) announce('Window move mode. Use arrow keys, Shift for larger moves, Enter to finish.'); });
  move.addEventListener('keydown', event => {
    if (move.getAttribute('aria-pressed') !== 'true') return;
    const step = event.shiftKey ? 64 : 20;
    const changes = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (changes[event.key]) { event.preventDefault(); const [x, y] = changes[event.key]; item.x += x; item.y += y; positionWindow(item); }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); move.setAttribute('aria-pressed', 'false'); help.hidden = true; announce('Window position set.'); }
  });
  focusWindow(key, true); renderDock(); syncExpandedCards(); return { ...item, isNew: true };
}
function positionWindow(item) {
  if (narrow()) {
    const top = Math.max(0, Math.min($('.topbar').getBoundingClientRect().bottom, innerHeight - 240));
    $('#window-layer').style.top = `${top}px`;
    return;
  }
  const layer = $('#window-layer'); const width = item.frame.offsetWidth || 540; const height = item.frame.offsetHeight || 460;
  layer.style.top = '';
  item.x = Math.max(12, Math.min(item.x, layer.clientWidth - width - 12)); item.y = Math.max(12, Math.min(item.y, layer.clientHeight - height - 12));
  item.frame.style.left = `${item.x}px`; item.frame.style.top = `${item.y}px`;
}
function setupDrag(item) {
  let drag = null;
  item.bar.addEventListener('pointerdown', event => {
    if (narrow() || event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault(); focusWindow(item.key, false); drag = { x: event.clientX, y: event.clientY, left: item.x, top: item.y, pointer: event.pointerId };
    item.bar.setPointerCapture(event.pointerId);
  });
  item.bar.addEventListener('pointermove', event => { if (!drag || event.pointerId !== drag.pointer) return; item.x = drag.left + event.clientX - drag.x; item.y = drag.top + event.clientY - drag.y; positionWindow(item); });
  const finish = event => { if (!drag || event.pointerId !== drag.pointer) return; if (item.bar.hasPointerCapture(event.pointerId)) item.bar.releasePointerCapture(event.pointerId); drag = null; };
  item.bar.addEventListener('pointerup', finish); item.bar.addEventListener('pointercancel', finish);
}
function focusWindow(key, moveFocus) {
  const item = view.windows.get(key); if (!item) return;
  if (view.focusKey !== key) { view.focusKey = key; item.frame.style.zIndex = String(++view.z); view.windows.forEach(window => window.frame.classList.toggle('is-focused', window.key === key)); renderDock(); }
  if (moveFocus) requestAnimationFrame(() => item.frame.isConnected && item.frame.focus({ preventScroll: true }));
}
function closeWindow(key, restoreFocus = true) {
  const item = view.windows.get(key); if (!item) return;
  view.windows.delete(key); item.frame.remove();
  if (view.focusKey === key) {
    view.focusKey = null; const next = [...view.windows.keys()].at(-1);
    if (next) focusWindow(next, restoreFocus);
    else if (restoreFocus) { const target = item.opener?.isConnected ? item.opener : $('#workspace-title'); if (!target.hasAttribute('tabindex') && target.tagName !== 'BUTTON') target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }
  renderDock(); syncExpandedCards();
}
function closeAllWindows() { [...view.windows.keys()].forEach(key => closeWindow(key, false)); view.focusKey = null; }
function syncExpandedCards() { document.querySelectorAll('[data-request]').forEach(card => card.setAttribute('aria-expanded', String(view.windows.has(`request:${card.dataset.request}`)))); }
function renderDock() {
  const buttons = [...view.windows.values()].map(item => { const control = button(`${item.type} · ${item.context}`, `dock-button ${view.focusKey === item.key ? 'is-active' : ''}`, () => focusWindow(item.key, true)); control.setAttribute('aria-label', `Focus ${item.type.toLowerCase()} for ${item.context}`); return control; });
  $('#dock-items').replaceChildren(...buttons); $('#dock-empty').hidden = buttons.length > 0; $('#reset-windows').hidden = buttons.length === 0;
}
$('#search').addEventListener('input', event => { view.search = event.target.value.trim().toLowerCase(); renderContent(); });
$('#department-filter').addEventListener('change', event => { view.department = event.target.value; renderContent(); });
$('#refresh-button').addEventListener('click', () => loadWorkspace());
document.querySelectorAll('[data-persona]').forEach(control => control.addEventListener('click', () => { if (control.dataset.persona !== view.persona) loadWorkspace(control.dataset.persona); }));
$('#reset-windows').addEventListener('click', () => { [...view.windows.values()].forEach((item, index) => { item.x = 26 + (index % 4) * 32; item.y = 22 + (index % 4) * 25; positionWindow(item); }); announce('Open windows arranged.'); });
window.addEventListener('resize', () => view.windows.forEach(positionWindow));
window.addEventListener('scroll', () => { if (narrow()) view.windows.forEach(positionWindow); }, { passive: true });
setInterval(() => {
  if (!view.data || view.loading || document.visibilityState !== 'visible') return;
  const focused = document.activeElement?.closest('[data-request], [data-customer]');
  const focusRequest = focused?.dataset.request; const focusCustomer = focused?.dataset.customer;
  renderSummary(); renderContent();
  if (focusRequest || focusCustomer) {
    const replacement = [...document.querySelectorAll('[data-request], [data-customer]')].find(node => focusRequest ? node.dataset.request === focusRequest : node.dataset.customer === focusCustomer);
    replacement?.focus({ preventScroll: true });
  }
  const byId = new Map(view.data.requests.map(request => [String(request.id), request]));
  document.querySelectorAll('[data-response-clock]').forEach(node => {
    const request = byId.get(node.dataset.responseClock); if (!request) return;
    node.textContent = timerText(request); node.className = `response-timer is-${band(request)}`;
  });
}, 30000);
loadWorkspace();
