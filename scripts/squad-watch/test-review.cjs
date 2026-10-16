'use strict';

// Synthetic evidence is confined to a disposable local clone; never real state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const p = require('./policy.cjs');
const review = require('./review.cjs');
const original = process.cwd();
const cfg = p.config();
const directory = path.join(original, '.watch-validation', `review-contracts-${process.platform}-${process.pid}`);
const clone = path.join(directory, 'checkout');
let passed = 0;
let baseSha;

function write(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
}

function clean() {
  assert.equal(process.cwd(), clone);
  fs.rmSync(path.join(clone, '.copilot-tracking', 'squad'), { force: true, recursive: true });
  for (const filename of p.git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString().split('\0').filter(Boolean)) {
    const absolute = path.resolve(filename);
    assert(absolute.startsWith(clone + path.sep));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
  p.git(['read-tree', 'HEAD']);
  p.git(['checkout-index', '--all', '--force'], { stdio: 'ignore' });
}

function fixture(automatic = true) {
  const outputs = {};
  const writes = [];
  const repo = { owner: 'Peter-N91', repo: 'grubify' };
  const pr = { id: 107, number: 7, state: 'open', merged: false, draft: true,
    head: { sha: 'c'.repeat(40), ref: 'squad/issue-42', repo: { full_name: cfg.repository } },
    base: { sha: baseSha, ref: 'main', repo: { full_name: cfg.repository } },
    labels: [{ name: 'squad/review' }], changed_files: 1, title: 'Sanitized fix', body: 'Review this source' };
  const run = { id: 123, run_attempt: 2, path: '.github/workflows/squad-watch.yml',
    repository: { full_name: cfg.repository }, head_repository: { id: 9, full_name: cfg.repository },
    head_branch: 'main', head_sha: baseSha, event: 'issues', status: 'in_progress', conclusion: null,
    actor: { login: 'writer' }, triggering_actor: { login: 'maintainer' } };
  const linkage = { schemaVersion: 1, status: 'draft-created', repository: cfg.repository,
    sourceRunId: '123', sourceAttempt: '2', requestAttempt: '1',
    sourceWorkflow: '.github/workflows/squad-watch.yml', actor: 'writer',
    requestActor: 'writer', applyActor: 'maintainer', issue: 42, pr: 7,
    branch: 'squad/issue-42', baseSha, headSha: pr.head.sha, label: 'squad/review' };
  const linkageBytes = JSON.stringify(linkage);
  write(path.join(process.env.SOURCE_RESULT_DIR, 'result.json'), linkageBytes);
  const artifact = { id: 1005, name: 'squad-result-123-2', expired: false, size_in_bytes: 800,
    workflow_run: { id: 123, head_repository_id: 9, head_sha: baseSha, head_branch: 'main' } };
  const jobs = { total_count: 5, jobs: [{ name: 'apply', run_id: 123, conclusion: 'success' }] };
  const permissions = {};
  const comments = [];
  const sourceCalls = [];
  const context = { repo, runId: 456, actor: automatic ? 'github-actions[bot]' : 'writer',
    eventName: 'workflow_dispatch', ref: 'refs/heads/main', sha: baseSha,
    payload: { inputs: automatic ? { pr_number: '7', source_run_id: '123',
      source_attempt: '2', result_artifact_id: '1005', result_sha256: p.digest(linkageBytes) } : { pr_number: '7' } } };
  process.env.TRIGGERING_ACTOR = context.actor;
  const github = { rest: {
    repos: {
      get: async () => ({ data: { full_name: cfg.repository, default_branch: 'main' } }),
      getBranch: async () => ({ data: { commit: { sha: baseSha } } }),
      getCollaboratorPermissionLevel: async ({ username }) => ({
        data: { permission: permissions[username] || (username === 'github-actions[bot]' ? 'read' : 'write') }
      }),
      getContent: async args => {
        sourceCalls.push(args);
        const bytes = Buffer.from(args.ref === pr.head.sha ? 'New reviewed source\n' : 'Old source\n');
        return { data: { type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length } };
      }
    },
    actions: {
      getWorkflowRun: async () => ({ data: run }),
      listJobsForWorkflowRunAttempt: async () => ({ data: jobs }),
      getArtifact: async () => ({ data: artifact })
    },
    git: { getCommit: async () => ({ data: { sha: pr.head.sha, parents: [{ sha: baseSha }], message: 'fix\nRun: 123' } }) },
    pulls: {
      get: async () => ({ data: pr }),
      listFiles: async () => ({ data: [{ filename: 'GrubifyApi/Reviewed.cs', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }] })
    },
    issues: {
      listComments: async () => ({ data: comments }),
      createComment: async args => { writes.push(args); comments.push({ user: { login: 'github-actions[bot]' }, body: args.body }); }
    }
  } };
  const core = { setOutput: (key, value) => { outputs[key] = value; }, info: () => {}, warning: () => {} };
  return { github, context, core, outputs, writes, pr, run, linkage, artifact, jobs, permissions, comments, sourceCalls };
}

async function prepare(api) {
  await review.prepare(api);
  if (api.outputs.authorized !== 'true') return;
  const request = JSON.parse(fs.readFileSync(path.join(process.env.REQUEST_DIR, 'request.json')));
  process.env.EXPECTED_BASE_SHA = request.baseSha;
  process.env.EXPECTED_REQUEST_SHA256 = api.outputs.request_sha256;
  process.env.EXPECTED_REQUEST_ATTEMPT = api.outputs.producer_attempt;
  process.env.EXPECTED_REQUEST_ARTIFACT = api.outputs.artifact_name;
  process.env.EXPECTED_REQUEST_ARTIFACT_ID = '1006';
  return request;
}

function evidence(request, changes = {}) {
  const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
  const report = { schemaVersion: 1, pr: request.pr, baseSha: request.prBaseSha,
    headSha: request.headSha, verdict: 'Pass-With-Findings', scope: ['GrubifyApi/Reviewed.cs'],
    findings: 'High: GrubifyApi/Reviewed.cs:1 — synthetic source finding @person <script> ![x](url)',
    limitations: 'Synthetic fixture only; dynamic tests were not executed. Human code validation required.',
    testsExecuted: false, dispatches: [{ agent: 'Squad Reviewer',
      history: 'history/Squad Reviewer.md', artifact: 'reviews/source-review.txt' }], ...changes };
  write('.copilot-tracking/squad/federation.md',
    `| Sub-squad | Profile | Kind | Location | Owner | Description |\n| ${request.subSquad} | default | in-repo | members/${request.subSquad}/ | watch-mode | ${request.ref} |\n`);
  write(`.copilot-tracking/squad/history/${request.subSquad}.md`, 'Synthetic bootstrap\n');
  write(root + 'state.json', JSON.stringify({ schemaVersion: '1.4', trigger: {
    ref: request.ref, eventId: request.eventId, source: 'pr', actor: request.actor,
    runId: 'autopilot-run-review-fixture' } }));
  write(root + 'team.md', 'Synthetic tester: Squad Reviewer\n');
  write(root + 'consumption.md', 'Synthetic consumption; no actual model run\n');
  write(root + 'decisions.md', 'Synthetic decisions\n## Blocking findings\nDynamic testing pending\n');
  write(root + 'history/autopilot-run-review-fixture.md', 'Synthetic autopilot; NOT genuine live dispatch\n');
  write(root + 'history/Squad Reviewer.md', 'Synthetic tester history, artifact reviews/source-review.txt\n');
  write(root + 'reviews/source-review.txt', 'Synthetic domain evidence referencing GrubifyApi/Reviewed.cs:1\n');
  write(root + 'review.json', JSON.stringify(report));
  return { root, report };
}

function staged(api) {
  const result = review.stage(api.context);
  process.env.EXPECTED_REVIEW_SHA256 = result.digest;
  process.env.EXPECTED_REVIEW_ATTEMPT = result.attempt;
  process.env.EXPECTED_REVIEW_ARTIFACT = result.name;
  process.env.EXPECTED_REVIEW_ARTIFACT_ID = '1007';
  return result;
}

async function test(name, action) {
  clean();
  process.env.GITHUB_RUN_ATTEMPT = '1';
  try { await action(); passed++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

async function run() {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', original, clone], { stdio: 'pipe' });
  process.chdir(clone);
  write('.github/squad-watch.json', JSON.stringify(cfg));
  fs.appendFileSync('.git/info/exclude', '\n/.github/squad-watch.json\n/.watch-run/\n');
  baseSha = p.git(['rev-parse', 'HEAD']).toString().trim();
  process.env.REQUEST_DIR = path.join(clone, '.watch-run');
  process.env.SOURCE_RESULT_DIR = path.join(directory, 'source');
  process.env.REVIEW_RESULT_DIR = path.join(directory, 'review-result');
  process.env.GITHUB_RUN_ID = '456';
  await test('ignored real review audit stages and independently reconstructs before publication', async () => {
    const api = fixture();
    const request = await prepare(api);
    evidence(request);
    const previous = fs.readFileSync('.git/info/exclude');
    fs.appendFileSync('.git/info/exclude', '\n/.copilot-tracking/squad/\n');
    try {
      staged(api);
      clean();
      await review.publish(api);
      assert.equal(api.writes.length, 1);
      assert(api.writes[0].body.includes('NOT approval'));
    } finally {
      fs.writeFileSync('.git/info/exclude', previous);
    }
  });
  await test('automatic producer, not current review run, selects immutable source ID', async () => {
    const api = fixture();
    await review.select(api);
    assert.equal(api.outputs.source_run, '123');
    assert.equal(api.outputs.result_artifact_id, '1005');
    const request = await prepare(api);
    assert.equal(request.runId, '456');
    assert.equal(request.runAttempt, '1');
    assert.equal(request.automatic.source_attempt, '2');
    assert.equal(request.subSquad, 'pr-7');
    assert.equal(request.source, 'pr');
    assert.equal(request.maxAiCredits, 90);
    assert.equal(request.headSha, api.linkage.headSha);
    assert.equal(api.sourceCalls.length, 2);
    assert.deepEqual(api.sourceCalls.map(call => call.ref), [baseSha, 'c'.repeat(40)]);
    assert.equal(api.writes.length, 0);
  });
  for (const [field, value] of [['id', 456], ['run_attempt', 1],
    ['path', '.github/workflows/untrusted.yml'], ['head_branch', 'other'], ['head_sha', 'b'.repeat(40)],
    ['repository', { full_name: 'other/repo' }], ['head_repository', { full_name: 'fork/repo' }],
    ['conclusion', 'failure'], ['event', 'pull_request']]) {
    await test(`source run rejects ${field}`, async () => {
      const api = fixture();
      api.run[field] = value;
      await assert.rejects(review.select(api));
      assert.equal(api.writes.length, 0);
    });
  }
  for (const [field, value] of [['id', 999], ['name', 'squad-result-123-1'], ['expired', true],
    ['size_in_bytes', 100001], ['workflow_run', { id: 456, head_sha: baseSha }]]) {
    await test(`artifact metadata rejects ${field}`, async () => {
      const api = fixture();
      api.artifact[field] = value;
      await assert.rejects(review.select(api));
    });
  }
  await test('unsuccessful or ambiguous source apply producer refused', async () => {
    for (const jobs of [[], [{ name: 'apply', run_id: 123, conclusion: 'failure' }],
      [{ name: 'apply', run_id: 123, conclusion: 'success' }, { name: 'apply', run_id: 123, conclusion: 'success' }]]) {
      const api = fixture();
      api.jobs.jobs = jobs;
      await assert.rejects(review.select(api));
    }
  });
  await test('source result digest and extra files are checked before snapshot', async () => {
    const api = fixture();
    fs.appendFileSync(path.join(process.env.SOURCE_RESULT_DIR, 'result.json'), ' ');
    await assert.rejects(prepare(api), /checksum/);
    fixture();
    write(path.join(process.env.SOURCE_RESULT_DIR, 'extra.json'), '{}');
    await assert.rejects(prepare(api), /only result/);
    fs.unlinkSync(path.join(process.env.SOURCE_RESULT_DIR, 'extra.json'));
    assert.equal(api.sourceCalls.length, 0);
  });
  for (const [field, value] of [['pr', 8], ['headSha', 'b'.repeat(40)], ['baseSha', 'b'.repeat(40)],
    ['branch', 'squad/issue-99'], ['actor', 'stranger'], ['sourceAttempt', '1'],
    ['requestAttempt', '3'], ['label', 'other'], ['status', 'no-change']]) {
    await test(`actual generated draft linkage rejects ${field}`, async () => {
      const api = fixture();
      api.linkage[field] = value;
      const bytes = JSON.stringify(api.linkage);
      write(path.join(process.env.SOURCE_RESULT_DIR, 'result.json'), bytes);
      api.context.payload.inputs.result_sha256 = p.digest(bytes);
      await assert.rejects(prepare(api));
      assert.equal(api.sourceCalls.length, 0);
    });
  }
  await test('actual commit ancestry and run provenance are verified', async () => {
    const api = fixture();
    api.github.rest.git.getCommit = async () => ({ data: {
      sha: api.pr.head.sha, parents: [{ sha: 'b'.repeat(40) }], message: 'Run: 123' } });
    await assert.rejects(prepare(api), /source-run commit/);
  });
  for (const actor of ['writer', 'maintainer']) {
    await test(`source collaborator ${actor} unauthorized`, async () => {
      const api = fixture();
      api.permissions[actor] = 'read';
      await assert.rejects(prepare(api));
      assert.equal(api.writes.length, 0);
    });
  }
  await test('source request producer and unauthorized current review rerun denied', async () => {
    const api = fixture();
    process.env.TRIGGERING_ACTOR = 'reader';
    api.permissions.reader = 'read';
    await assert.rejects(prepare(api), /rerun actor/);
    process.env.TRIGGERING_ACTOR = 'github-actions[bot]';
    api.linkage.requestActor = 'reader';
    const bytes = JSON.stringify(api.linkage);
    write(path.join(process.env.SOURCE_RESULT_DIR, 'result.json'), bytes);
    api.context.payload.inputs.result_sha256 = p.digest(bytes);
    await assert.rejects(prepare(api), /producer actor/);
  });
  await test('manual collaborator recovery works without source artifact or repository PAT', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    assert.equal(request.automatic, null);
    assert.equal(api.outputs.authorized, 'true');
    assert.equal(api.writes.length, 0);
  });
  await test('manual initial/rerun collaborators and bot without provenance denied', async () => {
    for (const actor of ['writer', 'reader', 'github-actions[bot]']) {
      const api = fixture(false);
      if (actor === 'writer') api.permissions.writer = 'read';
      else {
        process.env.TRIGGERING_ACTOR = actor;
        api.permissions[actor] = 'read';
      }
      await prepare(api);
      assert.equal(api.outputs.authorized, 'false');
    }
  });
  for (const mutation of [
    api => { api.pr.head.repo.full_name = 'fork/grubify'; },
    api => { api.pr.base.ref = 'other'; },
    api => { api.pr.state = 'closed'; },
    api => { api.pr.labels = []; },
    api => { api.pr.draft = false; },
    api => { api.context.ref = 'refs/heads/feature'; },
    api => { api.context.sha = 'b'.repeat(40); },
    api => { api.context.eventName = 'pull_request'; },
    api => { delete api.context.payload.inputs.result_sha256; }
  ]) {
    await test('fork/closed/unlabeled/stale/non-main/partial source refused', async () => {
      const api = fixture();
      mutation(api);
      await assert.rejects(prepare(api));
      assert.equal(api.writes.length, 0);
    });
  }
  await test('duplicate marker blocks paid work across automatic/manual triggers', async () => {
    const api = fixture(false);
    api.comments.push({ user: { login: 'github-actions[bot]' },
      body: `<!-- squad-review:7:${api.pr.head.sha} -->\nAlready reviewed` });
    await prepare(api);
    assert.equal(api.outputs.authorized, 'false');
    assert.equal(api.sourceCalls.length, 0);
    api.comments[0].user.login = 'human';
    assert(await prepare(api), 'A human must not spoof the trusted bot marker');
  });
  await test('comment marker scan uses later pages and fails on unbounded history', async () => {
    const api = fixture(false);
    api.github.rest.issues.listComments = async ({ page }) => ({ data: page === 1 ?
      Array.from({ length: 100 }, () => ({ user: { login: 'human' }, body: 'x' })) :
      [{ user: { login: 'github-actions[bot]' }, body: `<!-- squad-review:7:${api.pr.head.sha} -->\nreview` }] });
    await prepare(api);
    assert.equal(api.outputs.authorized, 'false');
    api.github.rest.issues.listComments = async () => ({
      data: Array.from({ length: 100 }, () => ({ user: { login: 'human' }, body: 'x' })) });
    await assert.rejects(prepare(api), /scan bound/);
  });
  await test('snapshot incomplete/binary/omitted source limitations not invented passes', async () => {
    const api = fixture(false);
    api.github.rest.pulls.listFiles = async () => ({ data: [{ filename: 'GrubifyApi/a.bin', status: 'added' }] });
    api.github.rest.repos.getContent = async () => ({ data: {
      type: 'file', encoding: 'base64', content: Buffer.from([0]).toString('base64'), size: 1 } });
    await prepare(api);
    const input = JSON.parse(fs.readFileSync(path.join(process.env.REQUEST_DIR, 'snapshot.json')));
    assert.equal(input.files[0].limitations.length, 2);
    api.pr.changed_files = 151;
    await assert.rejects(prepare(api), /file count/);
  });
  await test('snapshot aggregate caps, API byte mismatch and private data fail closed', async () => {
    const api = fixture(false);
    api.pr.body = '/subscriptions/' + 'x'.repeat(32);
    await assert.rejects(prepare(api), /private identifier/);
    api.pr.body = '';
    api.github.rest.repos.getContent = async () => ({ data: { type: 'file',
      encoding: 'base64', content: 'eA==', size: 2 } });
    await assert.rejects(prepare(api), /size mismatch/);
    api.github.rest.repos.getContent = async () => ({ data: { type: 'directory' } });
    api.github.rest.pulls.listFiles = async () => ({ data: [{
      filename: 'GrubifyApi/x', status: 'modified', patch: 'x'.repeat(cfg.review.maximumSnapshotBytes + 1) }] });
    await assert.rejects(prepare(api), /aggregate/);
  });
  await test('PR changes during snapshot refused', async () => {
    const api = fixture(false);
    let reads = 0;
    api.github.rest.pulls.get = async () => ({ data: ++reads === 1 ? api.pr :
      { ...api.pr, head: { ...api.pr.head, sha: 'b'.repeat(40) } } });
    await assert.rejects(prepare(api), /during snapshot/);
  });
  await test('prompt is separate scoped session with locked cast, no payload interpolation', async () => {
    const request = await prepare(fixture());
    const value = review.prompt(request);
    assert(value.includes('NEW independent'));
    assert(value.includes('sub=pr-7'));
    assert(value.includes('Squad Reviewer'));
    assert(value.includes('Code Review Functional'));
    assert(value.includes('| Sub-squad | Profile | Kind | Location | Owner | Description |'));
    assert(value.includes(`| watch: ${request.ref} | ${request.subSquad} | no |`));
    assert(value.includes(`trigger.eventId="${request.eventId}"`));
    assert(value.includes('never execute PR code/tests'));
    assert(!value.includes('squad=pr-7'));
    assert(!value.includes('Review this source'));
  });
  await test('request digest and snapshot identity protect pre-model inputs', async () => {
    const api = fixture();
    await prepare(api);
    fs.appendFileSync(path.join(process.env.REQUEST_DIR, 'snapshot.json'), ' ');
    await assert.rejects(review.revalidate(api), /snapshot digest/);
    await prepare(api);
    process.env.EXPECTED_REQUEST_SHA256 = 'a'.repeat(64);
    await assert.rejects(review.revalidate(api), /provenance/);
  });
  for (const mutation of [
    api => { api.pr.head.sha = 'b'.repeat(40); },
    api => { api.pr.base.sha = 'b'.repeat(40); },
    api => { api.pr.labels = []; },
    api => { api.permissions.writer = 'read'; },
    api => { process.env.TRIGGERING_ACTOR = 'reader'; api.permissions.reader = 'read'; }
  ]) {
    await test('current PR/base/label/auth revalidated before model and publication', async () => {
      const api = fixture();
      await prepare(api);
      mutation(api);
      await assert.rejects(review.revalidate(api));
      await assert.rejects(review.publish(api));
      assert.equal(api.writes.length, 0);
    });
  }
  await test('full static audit handoff publishes one escaped comment, keeps draft and branch', async () => {
    const api = fixture();
    const request = await prepare(api);
    evidence(request);
    staged(api);
    clean();
    await review.publish(api);
    assert.equal(api.writes.length, 1);
    const comment = api.writes[0];
    assert.equal(comment.issue_number, 7);
    assert(comment.body.startsWith(review.marker(request) + '\n'));
    assert(comment.body.includes('not executed'));
    assert(comment.body.includes('\\@person'));
    assert(comment.body.includes('\\<script\\>'));
    assert(comment.body.includes('NOT approval'));
    assert.equal(api.pr.draft, true);
    assert.equal(api.pr.head.sha, request.headSha);
    await review.publish(api);
    assert.equal(api.writes.length, 1);
  });
  await test('apply-only review publication rerun preserves earlier producer/origin', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    evidence(request);
    staged(api);
    clean();
    process.env.GITHUB_RUN_ATTEMPT = '3';
    process.env.TRIGGERING_ACTOR = 'maintainer';
    await review.publish(api);
    assert.equal(api.writes.length, 1);
  });
  await test('review-only rerun preserves immutable request and creates new producer', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    process.env.GITHUB_RUN_ATTEMPT = '2';
    process.env.TRIGGERING_ACTOR = 'maintainer';
    await review.revalidate(api);
    evidence(request);
    const result = staged(api);
    assert.equal(result.name, 'squad-review-result-456-2');
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.REVIEW_RESULT_DIR, 'review.json')));
    assert.equal(stored.requestAttempt, '1');
    assert.equal(stored.runAttempt, '2');
    clean();
    process.env.GITHUB_RUN_ATTEMPT = '3';
    await review.publish(api);
    assert.equal(api.writes.length, 1);
  });
  await test('out-of-scope source edits, missing role artifacts, forged tests and oversized findings denied', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    evidence(request);
    write('GrubifyApi/no-review-edits.txt', 'must not change code');
    assert.throws(() => staged(api), /cannot modify application/);
    fs.unlinkSync('GrubifyApi/no-review-edits.txt');
    const { root } = evidence(request);
    fs.unlinkSync(root + 'reviews/source-review.txt');
    assert.throws(() => staged(api), /artifact.*missing/);
    clean();
    evidence(request, { testsExecuted: true });
    assert.throws(() => staged(api), /test claim/);
    clean();
    evidence(request, { findings: 'x'.repeat(12001) });
    assert.throws(() => staged(api), /oversized/);
  });
  await test('state-only evidence or invented tester cannot impersonate second Squad', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    evidence(request, { dispatches: [{ agent: 'Squad Reviewer', history: 'history/Squad Reviewer.md', artifact: 'state.json' }] });
    assert.throws(() => staged(api), /state-only/);
    clean();
    evidence(request, { dispatches: [{ agent: 'Invented QA', history: 'history/Invented QA.md', artifact: 'reviews/x.txt' }] });
    assert.throws(() => staged(api));
  });
  await test('source-unanchored scope, invalid verdict and secret/private report output denied', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    for (const changes of [{ scope: ['invented/file.cs'] }, { verdict: 'APPROVE' },
      { findings: 'github_pat_' + 'x'.repeat(30) }, { findings: 'a@example.test' }]) {
      clean();
      evidence(request, changes);
      assert.throws(() => staged(api));
    }
  });
  await test('result checksum, current actor and wrong/future producer attempt refused', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    evidence(request);
    staged(api);
    clean();
    const file = path.join(process.env.REVIEW_RESULT_DIR, 'review.json');
    const bytes = fs.readFileSync(file);
    fs.appendFileSync(file, ' ');
    await assert.rejects(review.publish(api), /digest/);
    fs.writeFileSync(file, bytes);
    process.env.EXPECTED_REVIEW_ATTEMPT = '2';
    await assert.rejects(review.publish(api), /producer/);
    process.env.EXPECTED_REVIEW_ATTEMPT = '1';
    const stored = JSON.parse(bytes);
    stored.producerActor = 'reader';
    api.permissions.reader = 'read';
    const tampered = JSON.stringify(stored);
    fs.writeFileSync(file, tampered);
    process.env.EXPECTED_REVIEW_SHA256 = p.digest(tampered);
    await assert.rejects(review.publish(api), /producer/);
    assert.equal(api.writes.length, 0);
  });
  await test('publication independently checks audit and domain report consistency', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    evidence(request);
    staged(api);
    clean();
    const filename = path.join(process.env.REVIEW_RESULT_DIR, 'review.json');
    const stored = JSON.parse(fs.readFileSync(filename));
    stored.report.findings = 'Forged publication findings';
    const bytes = JSON.stringify(stored);
    fs.writeFileSync(filename, bytes);
    process.env.EXPECTED_REVIEW_SHA256 = p.digest(bytes);
    await assert.rejects(review.publish(api), /does not match/);
    assert.equal(api.writes.length, 0);
  });
  await test('stale-head recheck immediately before sole comment write fails closed', async () => {
    const api = fixture(false);
    const request = await prepare(api);
    evidence(request);
    staged(api);
    clean();
    let reads = 0;
    api.github.rest.pulls.get = async () => ({ data: ++reads === 1 ? api.pr :
      { ...api.pr, head: { ...api.pr.head, sha: 'b'.repeat(40) } } });
    await assert.rejects(review.publish(api), /Stale PR/);
    assert.equal(api.writes.length, 0);
  });
  const workflow = fs.readFileSync(path.join(original, '.github/workflows/squad-review.yml'), 'utf8').replace(/\r\n/g, '\n');
  const generator = fs.readFileSync(path.join(original, '.github/workflows/squad-watch.yml'), 'utf8').replace(/\r\n/g, '\n');
  await test('job environment uses supported contexts and initializes runner paths at step time', () => {
    for (const definition of [workflow, generator]) {
      for (const block of definition.matchAll(/^    env:\n((?:^      [^\n]*\n)+)/gm)) {
        assert.doesNotMatch(block[1], /\$\{\{\s*(?:runner|env|steps|job)\./,
          'These contexts are unavailable in jobs.<job_id>.env');
      }
    }
    const reviewJob = workflow.split('\n  review:')[1].split('\n  publish:')[0];
    const publishJob = workflow.split('\n  publish:')[1];
    assert(reviewJob.includes("printf 'SOURCE_RESULT_DIR=%s/squad-source-result\\n'"));
    for (const name of ['REQUEST_DIR', 'REVIEW_RESULT_DIR', 'SOURCE_RESULT_DIR']) {
      assert(publishJob.includes(`printf '${name}=%s/`));
    }
    for (const job of [reviewJob, publishJob]) {
      assert(job.indexOf('Initialize runner-local artifact path') < job.indexOf('- uses: actions/checkout@'));
      assert(job.includes('"$RUNNER_TEMP" >> "$GITHUB_ENV"'));
    }
  });
  await test('actual embedded dispatcher sends exact PR/source-attempt/artifact linkage and explicit failure recovery', async () => {
    const block = generator.split('\n  dispatch-review:')[1].split('\n  notify:')[0];
    const script = block.split('script: |\n')[1].split('\n')
      .filter(line => line.startsWith('            ')).map(line => line.slice(12)).join('\n');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const dispatch = new AsyncFunction('github', 'context', script);
    const calls = [];
    const api = fixture();
    process.env.PR = '7';
    process.env.ARTIFACT_ID = '1005';
    process.env.RESULT_SHA256 = api.context.payload.inputs.result_sha256;
    process.env.GITHUB_RUN_ATTEMPT = '2';
    const github = { rest: { actions: { createWorkflowDispatch: async args => { calls.push(args); } } } };
    await dispatch(github, { ...api.context, runId: 123 });
    assert.deepEqual(calls, [{ ...api.context.repo, workflow_id: 'squad-review.yml', ref: 'main',
      inputs: { pr_number: '7', source_run_id: '123', source_attempt: '2',
        result_artifact_id: '1005', result_sha256: process.env.RESULT_SHA256 } }]);
    const fail = { rest: { actions: { createWorkflowDispatch: async () => { throw new Error('API denied'); } } } };
    await assert.rejects(dispatch(fail, { ...api.context, runId: 123 }), /pull\/7.*dispatch failed/);
    process.env.ARTIFACT_ID = 'unsafe';
    await assert.rejects(dispatch(github, api.context), /Invalid review linkage/);
    assert.equal(calls.length, 1);
  });
  assert(workflow.includes("vars.SQUAD_WATCH_ENABLED == 'true'"));
  const runner = fs.readFileSync(path.join(original, 'scripts/squad-watch/run-review.sh'), 'utf8');
  assert(runner.includes('$CREDITS" == "90"'));
  assert(runner.includes('--agent hve-squad:squad-federation-coordinator'));
  assert(!/^\s*(pull_request_target|pull_request|push|schedule|issues|issue_comment|workflow_run):/m
    .test(workflow.split('\npermissions:')[0]));
  assert(workflow.includes('group: squad-review-pr-${{ inputs.pr_number }}'));
  assert(workflow.includes('cancel-in-progress: false'));
  assert(generator.includes('actions: write'));
  assert(generator.includes('github.rest.actions.createWorkflowDispatch'));
  const runtime = workflow.split('\n  review:')[1].split('\n  publish:')[0];
  assert(!/^\s+(?:contents|issues|pull-requests|actions): write$/m.test(runtime));
  assert(!/secrets\.(?!COPILOT_GITHUB_TOKEN\b)/.test(workflow));
  const publish = workflow.split('\n  publish:')[1];
  assert(!publish.includes('secrets.'));
  assert(!/^\s+(?:contents|pull-requests|actions): write$/m.test(publish));
  assert(workflow.includes('run-id: ${{ steps.source.outputs.source_run }}'));
  assert(workflow.includes('artifact-ids: ${{ needs.review.outputs.result_artifact_id }}'));
  assert(!workflow.includes('github.event.pull_request.head.sha'));
  for (const item of workflow.matchAll(/uses:\s+(\S+)/g)) assert(/@[0-9a-f]{40}$/.test(item[1]));
  console.log(`Passed ${passed} offline independent-review contract cases plus trigger/credential/permission assertions. No AI or remote writes.`);
}

run().finally(() => {
  process.chdir(original);
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
