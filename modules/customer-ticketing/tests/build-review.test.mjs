import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
const artifacts = ['index.html', 'app.js', 'styles.css', 'fixtures/pm.json', 'fixtures/department.json', 'fixtures/president.json'];
const sampleTime = '2026-11-02T14:00:00.000Z';

async function cleanCheckout(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'beyond-batch-review-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['src', 'public', 'scripts', 'package.json']) {
    await cp(resolve(moduleRoot, name), resolve(directory, name), { recursive: true });
  }
  return directory;
}

function build(directory) {
  return spawnSync(process.execPath, ['scripts/build-review.mjs'], {
    cwd: directory,
    env: { ...process.env, REVIEW_SOURCE_DIR: resolve(directory, 'external-source-must-not-be-used') },
    encoding: 'utf8',
  });
}

test('review build works from a clean module and reproduces scoped sample payloads', async t => {
  const directory = await cleanCheckout(t);
  const first = build(directory);
  assert.equal(first.status, 0, first.stderr);
  const firstBytes = await Promise.all(artifacts.map(name => readFile(resolve(directory, 'dist/review', name))));
  const second = build(directory);
  assert.equal(second.status, 0, second.stderr);
  const secondBytes = await Promise.all(artifacts.map(name => readFile(resolve(directory, 'dist/review', name))));
  artifacts.forEach((name, index) => assert.deepEqual(secondBytes[index], firstBytes[index], `${name} changed on an identical build`));

  const counts = { pm: 3, department: 2, president: 6 };
  for (const persona of Object.keys(counts)) {
    const data = JSON.parse(await readFile(resolve(directory, 'dist/review/fixtures', `${persona}.json`), 'utf8'));
    assert.equal(data.now, sampleTime);
    assert.equal(data.coverage.mode, 'fictional');
    assert.equal(data.persona.role, persona);
    assert.equal(data.requests.length, counts[persona]);
    for (const request of data.requests) {
      assert.equal(request.outlookAction.status, 'not_connected');
      assert.equal(Object.hasOwn(request.outlookAction, 'href'), false);
      for (const key of ['rawEmail', 'rawBody', 'mailBody', 'attachments', 'accessToken', 'clientSecret', 'password']) {
        assert.equal(Object.hasOwn(request, key), false, `${persona} includes ${key}`);
      }
      if (persona === 'pm') assert.equal(request.owner, 'Avery');
      if (persona === 'department') assert.equal(request.department, 'QA');
    }
  }
  const html = firstBytes[0].toString();
  const app = firstBytes[1].toString();
  assert.match(html, /Team review • sample data/);
  assert.match(html, /Microsoft email not connected/);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(app, /\.\/fixtures\/\$\{persona\}\.json/);
  assert.match(app, /Reply in Outlook/);
  assert.match(app, /function openHowItWorks/);
  assert.doesNotMatch(app, /\/api\/workspace|innerHTML|outerHTML|insertAdjacentHTML/);
});

test('review build requires module source even when generated output exists', async t => {
  const directory = await cleanCheckout(t);
  assert.equal(build(directory).status, 0);
  await rm(resolve(directory, 'public/index.html'));
  await mkdir(resolve(directory, 'dist/review'), { recursive: true });
  const result = build(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT/);
  assert.match(result.stderr, /public\/index\.html/);
});
