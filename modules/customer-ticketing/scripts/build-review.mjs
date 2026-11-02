import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixtures, demoPrincipals } from '../src/fixtures.mjs';
import { projectWorkspace } from '../src/security/workspace.mjs';
import { getDemoEmailTrail } from '../src/fixtures/email-trails.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'dist/review');
const source = resolve(root, 'public');
const personas = ['pm', 'department', 'president'];
// A fixed sample clock makes clean-checkout builds byte-for-byte reproducible.
// November 2, 2026 at 8:00 a.m. America/Chicago. This is sample time, not live data.
const sampleTime = '2026-11-02T14:00:00.000Z';

function replaceOnce(text, before, after, name) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`Source changed: expected one ${name}, found ${count}. Review the adaptation before building.`);
  return text.replace(before, after);
}

const helpFunction = `function openHowItWorks() {
  const window = createWindow('help:workflow', 'Beyond Batch', 'How it works');
  if (!window.isNew) return;
  window.body.append(el('h2', '', 'From email to a clear answer'), el('p', 'window-context', 'The connected workflow this team review demonstrates.'));
  const steps = [
    ['Email arrives', 'With Microsoft connected, customer email is checked for specific requests. This review uses sample data.'],
    ['Each request becomes clear work', 'Separate asks get separate requests. Related emails stay linked to the same issue.'],
    ['One PM owns the answer', 'The PM remains accountable while QA, R&D or another department supplies the needed input.'],
    ['The 24-hour clock stays visible', 'A meaningful response is due within 24 elapsed hours, including weekends. Acknowledgments and internal activity do not satisfy it.'],
    ['Read and reply in the workspace', 'Open the email trail, then compose a reply inside Beyond Batch. This demo keeps drafts in session memory and cannot send. Open in Outlook remains a separate option once connected. The clock keeps running until a meaningful sent reply is verified.'],
    ['Completion is verified', 'A reply alone does not close the request. The required outcome and supporting evidence must be confirmed.']
  ];
  const list = el('ol', 'how-steps');
  for (const [title, description] of steps) {
    const item = el('li'); item.append(el('h3', '', title), el('p', '', description)); list.append(item);
  }
  window.body.append(list, el('p', 'history-note', 'Open a request, read its sample email trail and try composing a reply. Then switch to the President demo to review every open ask. Microsoft email is not connected; nothing is sent.'));
  window.actions.append(el('p', 'desktop-hint', 'Sample data only · Microsoft email not connected'), button('Back to the workspace', 'secondary-button', () => closeWindow('help:workflow')));
}

`;

const reviewCss = `
/* Static team-review presentation; no live connection is implied. */
.preview-label strong{display:block;font-weight:550;color:var(--text)}
.preview-label .connection-note{display:block;padding:0;margin-top:2px;font-size:11px;color:var(--muted)}
.heading-tools{display:flex;align-items:center;gap:24px;flex-shrink:0}
.how-steps{list-style:none;counter-reset:workflow-step;margin:22px 0 0;padding:0}
.how-steps li{counter-increment:workflow-step;position:relative;padding:0 0 20px 37px;min-height:38px}
.how-steps li::before{content:counter(workflow-step);position:absolute;left:0;top:0;width:24px;height:24px;border:1px solid var(--control);border-radius:50%;display:grid;place-items:center;color:var(--accent);font-size:12px;font-variant-numeric:tabular-nums}
.how-steps h3{font-size:14px;font-weight:600;margin:0 0 4px}
.how-steps p{font-size:13px;line-height:1.6;margin:0;color:var(--muted)}
.how-steps li:last-child{padding-bottom:0}
@media(max-width:1150px){.topbar-end .preview-label{max-width:190px}.heading-tools{gap:16px}}
@media(max-width:700px){.page-heading{align-items:flex-start;flex-direction:column;gap:16px}.heading-tools{width:100%;justify-content:flex-start}.heading-tools .secondary-button{min-height:44px}.topbar .preview-label{display:flex;flex-wrap:wrap;gap:3px 10px;align-items:baseline}.preview-label .connection-note{margin:0}.topbar-end .preview-label{max-width:none}}
`;

{
  let html = await readFile(resolve(source, 'index.html'), 'utf8');
  let app = await readFile(resolve(source, 'app.js'), 'utf8');
  const css = await readFile(resolve(source, 'styles.css'), 'utf8');

  html = replaceOnce(html, 'href="/styles.css"', 'href="./styles.css"', 'stylesheet reference');
  html = replaceOnce(html, 'src="/app.js"', 'src="./app.js"', 'script reference');
  html = replaceOnce(html, '<title>Beyond Batch · Requests</title>', '<title>Beyond Batch · Team Review</title>', 'page title');
  html = replaceOnce(html,
    '<span class="preview-label">Development preview <span aria-hidden="true">·</span> fictional data</span>',
    '<span class="preview-label"><strong>Team review • sample data</strong><span class="connection-note">Microsoft email not connected</span></span>',
    'review label');
  html = replaceOnce(html, 'aria-label="Demo persona; this does not change real access"', 'aria-label="Choose a sample view"', 'demo view label');
  html = replaceOnce(html, '<span class="persona-label">Demo view</span>', '<span class="persona-label">View demo</span>', 'view selector label');
  const clockNote = '<div class="clock-note"><span class="clock-dot" aria-hidden="true"></span><div><strong>24 elapsed hours</strong><span>Weekends count, too</span></div></div>';
  html = replaceOnce(html, clockNote, `<div class="heading-tools"><button class="secondary-button" id="how-it-works" type="button">How it works</button>${clockNote}</div>`, 'help button');
  html = html.replaceAll('Reload fictional workspace', 'Reload sample workspace').replaceAll('Loading fictional workspace…', 'Loading sample workspace…');

  app = replaceOnce(app,
    'async function loadWorkspace(persona = view.persona) {',
    `${helpFunction}async function loadWorkspace(persona = view.persona) {\n  if (!['pm', 'department', 'president'].includes(persona)) throw new Error('Unknown sample view.');`,
    'workspace loader');
  app = replaceOnce(app,
    'fetch(`/api/workspace?persona=${encodeURIComponent(persona)}`, { headers: { Accept: \'application/json\' }, cache: \'no-store\' })',
    'fetch(new URL(`./fixtures/${persona}.json`, import.meta.url), { headers: { Accept: \'application/json\' }, cache: \'no-store\' })',
    'static fixture fetch');
  app = replaceOnce(app,
    'fetch(`/api/email-trail?persona=${encodeURIComponent(persona)}&requestId=${encodeURIComponent(requestId)}`, { headers: { Accept: \'application/json\' }, cache: \'no-store\' })',
    'fetch(new URL(`./fixtures/${persona}-email-trails.json`, import.meta.url), { headers: { Accept: \'application/json\' }, cache: \'no-store\' }).then(async response => { if (!response.ok) return response; const trails = await response.json(); if (!trails || typeof trails !== \'object\' || Array.isArray(trails)) throw new Error(\'Invalid sample email trails\'); const trail = Object.hasOwn(trails, requestId) ? trails[requestId] : null; return new Response(JSON.stringify(trail), { status: trail ? 200 : 404, headers: { \'Content-Type\': \'application/json\' } }); })',
    'static email trail fetch');
  app = replaceOnce(app,
    "if (!data || !Array.isArray(data.requests) || !data.coverage || !data.persona) throw new Error('The workspace response is incomplete.');",
    "if (!data || !Array.isArray(data.requests) || data.coverage?.mode !== 'fictional' || !data.persona || data.persona.role !== persona) throw new Error('This review requires fictional data for the selected sample view.');",
    'sample-only response guard');
  app = replaceOnce(app,
    'The local development API did not return the workspace. Check that the demo server is running, then try again.',
    'The sample requests could not be loaded. Refresh this review or try again. Microsoft email is not connected.',
    'load error');
  app = replaceOnce(app,
    "$('#coverage-text').textContent = `${valueText(view.data.coverage.status, 'Demo only')} · ${valueText(view.data.coverage.detail, 'Fictional requests. Microsoft email is not connected.')}`;",
    "$('#coverage-text').textContent = 'Team review · sample requests only · Microsoft email not connected';",
    'coverage text');
  app = replaceOnce(app,
    "$('#as-of').textContent = `Timing from last load · ${formatDate(view.data.now)} Central`;",
    "$('#as-of').textContent = `Sample clock · ${formatDate(view.data.now)} Central`;",
    'sample clock label');
  app = app
    .replaceAll('Loading fictional workspace…', 'Loading sample workspace…')
    .replaceAll('No open requests are included in this fictional workspace.', 'No open requests are included in this sample view.')
    .replaceAll('This local preview shows fixture timing and permitted summaries. It does not open or fetch real email.', 'This review shows sample timing and request summaries. It does not open or fetch real email.')
    .replaceAll('Local text only · not saved to Outlook', 'Review text only · not saved to Outlook');
  app = replaceOnce(app,
    "$('#search').addEventListener('input',",
    "$('#how-it-works').addEventListener('click', openHowItWorks);\n$('#search').addEventListener('input',",
    'help listener');

  await mkdir(dist, { recursive: true });
  await writeFile(resolve(dist, 'index.html'), html);
  await writeFile(resolve(dist, 'app.js'), app);
  await writeFile(resolve(dist, 'styles.css'), `${css}\n${reviewCss}`);
  process.stdout.write('Built dist/review from this module\'s public UI.\n');
}

const app = await readFile(resolve(dist, 'app.js'), 'utf8');
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
if (/\/api\//.test(app) || /innerHTML|outerHTML|insertAdjacentHTML/.test(app)) throw new Error('Unexpected API or raw-HTML sink in the static review.');
if (/(?:src|href)=["']https?:/i.test(html)) throw new Error('The static review must not depend on external assets.');
if (!html.includes('Microsoft email not connected') || !html.includes('Team review • sample data')) throw new Error('Required review labels are missing.');
const syntax = spawnSync(process.execPath, ['--check', resolve(dist, 'app.js')], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr || 'JavaScript syntax check failed.');

const requests = makeFixtures(sampleTime);
const coverage = {
  mode: 'fictional', status: 'Team review',
  detail: 'Sample requests only. Microsoft email is not connected.',
};
await mkdir(resolve(dist, 'fixtures'), { recursive: true });
for (const persona of personas) {
  const data = projectWorkspace({ principal: demoPrincipals[persona], requests, now: sampleTime, coverage });
  if (data.coverage?.mode !== 'fictional' || data.persona?.role !== persona || !Array.isArray(data.requests)) throw new Error(`Invalid fictional ${persona} fixture.`);
  if (data.now !== sampleTime) throw new Error(`Unexpected ${persona} sample clock.`);
  if (data.requests.some(row => ['rawEmail', 'rawBody', 'mailBody', 'attachments'].some(field => Object.hasOwn(row, field)))) throw new Error(`Raw source content is not permitted in the ${persona} review fixture.`);
  if (data.requests.some(row => row.outlookAction?.status !== 'not_connected' || Object.hasOwn(row.outlookAction, 'href'))) throw new Error(`Connected Outlook actions are not permitted in the ${persona} sample view.`);
  await writeFile(resolve(dist, 'fixtures', `${persona}.json`), `${JSON.stringify(data, null, 2)}\n`);
  // Static artifacts contain fictional email examples only. This is a sample
  // view, not production source-mail authorization; the workspace stays lean.
  const trails = {};
  for (const row of data.requests) {
    const request = requests.find(item => item.id === row.id);
    const trail = getDemoEmailTrail({request,principal:demoPrincipals[persona]});
    if (!trail || trail.mode !== 'fictional' || trail.requestId !== row.id) throw new Error(`Missing ${persona} sample email trail.`);
    trails[row.id] = trail;
  }
  await writeFile(resolve(dist, 'fixtures', `${persona}-email-trails.json`), `${JSON.stringify(trails, null, 2)}\n`);
  process.stdout.write(`Generated ${persona} sample view: ${data.requests.length} requests.\n`);
}
process.stdout.write(`All three sample views use the fixed clock ${sampleTime}.\n`);
process.stdout.write('Static paths, labels, safe text rendering, and JavaScript syntax checks passed.\n');
