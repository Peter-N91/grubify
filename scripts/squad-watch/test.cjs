'use strict';

// Offline contract tests only. Synthetic audit fixtures stay in a disposable,
// local clone under .watch-validation; they never initialize the real squad.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const p = require('./policy.cjs');
const prepare = require('./prepare.cjs');
const handoff = require('./handoff.cjs');
const diagnostics = require('./diagnostics.cjs');
const apply = require('./apply.cjs');
const { verifyInputs } = require('./check-apm.cjs');
const original = process.cwd();
const cfg = p.config();
const directory = path.join(original, '.watch-validation', `contracts-${process.platform}-${process.pid}`);
const clone = path.join(directory, 'checkout');
let passed = 0;

function write(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function mock(request, options = {}) {
  const writes = [];
  const outputs = {};
  const issue = {
    id: 142, number: 42, title: 'Sanitized demo task', body: 'Acceptance: an offline fix',
    state: 'open', labels: [{ name: cfg.issueLabel }], ...options.issue
  };
  const github = { rest: {
    repos: {
      getCollaboratorPermissionLevel: async ({ username }) =>
        ({ data: { permission: options.permissions?.[username] || 'write' } }),
      get: async () => ({ data: { default_branch: 'main' } }),
      getBranch: async () => ({ data: { commit: { sha: options.baseSha || request.baseSha } } })
    },
    issues: { get: async () => ({ data: issue }),
      addLabels: async args => {
        writes.push(['label', args]);
        if (options.labelFailure) throw new Error('denied');
        return { data: args.labels.map(name => ({ name })) };
      } },
    pulls: {
      list: async () => ({ data: options.pulls || [] }),
      create: async args => { writes.push(['pr', args]); return { data: { draft: true, number: 7 } }; }
    },
    git: {
      getRef: async () => {
        if (options.existingBranch) return { data: {} };
        throw Object.assign(new Error('not found'), { status: 404 });
      },
      getCommit: async () => ({ data: { tree: { sha: 'base-tree' } } }),
      createBlob: async args => { writes.push(['blob', args]); return { data: { sha: 'new-blob' } }; },
      createTree: async args => { writes.push(['tree', args]); return { data: { sha: 'new-tree' } }; },
      createCommit: async args => { writes.push(['commit', args]); return { data: { sha: 'c'.repeat(40) } }; },
      createRef: async args => {
        writes.push(['ref', args]);
        if (options.refRace) throw Object.assign(new Error('ref collision'), { status: 422 });
      }
    }
  } };
  const context = {
    repo: { owner: 'Peter-N91', repo: 'grubify' }, actor: 'Peter-N91', runId: 123,
    sha: request.baseSha, ref: 'refs/heads/main', eventName: 'issues',
    payload: { action: 'labeled', label: { name: cfg.issueLabel }, issue }
  };
  const core = {
    setOutput: (key, value) => { outputs[key] = value; },
    info: () => {}, warning: () => {}
  };
  return { github, context, core, writes, outputs, issue };
}

function clean() {
  assert.equal(process.cwd(), clone, 'Fixture cleanup must stay in its disposable clone');
  fs.rmSync(path.join(clone, '.copilot-tracking', 'squad'), { force: true, recursive: true });
  const files = p.git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const filename of files) {
    const absolute = path.resolve(clone, filename);
    assert(absolute.startsWith(clone + path.sep), 'Fixture path must stay inside its disposable clone');
    fs.rmSync(absolute, { force: true, recursive: true });
  }
  p.git(['read-tree', 'HEAD']);
  p.git(['checkout-index', '--all', '--force'], { stdio: 'ignore' });
}

function fixtures(request, options = {}) {
  const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
  const state = {
    schemaVersion: '1.4',
    updated: '2026-10-15T00:00:00Z', turn: 1, mode: 'autopilot',
    activeRoles: ['developer'], openEscalations: [],
    currentRun: {
      sessionModel: cfg.model, modelOverrides: {}, estCostUsd: 0, estCreditsTotal: 0,
      costPreflight: {
        runId: '', roundId: '', ceilingUsd: null, evaluatedSpendUsd: 0, remainingUsd: null,
        plannedDispatches: 0, projectedCostUsd: 0, reserveMultiplier: 3,
        admissionCostUsd: 0, confidence: 'not-applicable', basis: 'not-requested',
        decision: 'not-requested', reason: 'Offline synthetic fixture; no actual dispatch.'
      }
    },
    notify: { approvalChannel: 'in-chat', enabled: false, email: '', github: { handle: '', repo: '' } },
    trigger: { source: request.source, ref: request.ref, eventId: request.eventId,
      actor: request.actor, runId: 'autopilot-run-offline-fixture' }
  };
  write('GrubifyApi/watch-contract-fixture.txt', options.content || 'Proposed text fix\n');
  write('.copilot-tracking/squad/federation.md',
    `# Squad Federation — synthetic fixture only\n\n## Sub-Squads\n\n| Sub-squad | Profile | Kind | Location | Owner | Description |\n|-----------|---------|------|----------|-------|-------------|\n| ${request.subSquad}   | default | in-repo | members/${request.subSquad}/ | watch-mode | ${request.ref} draft |\n`);
  write(`.copilot-tracking/squad/history/${request.subSquad}.md`, 'Synthetic bootstrap evidence\n');
  write(root + 'state.json', JSON.stringify(state));
  write(root + 'team.md', '# Synthetic test roster — not live dispatch\n\n' +
    '| Role | Member Name | Agent Name (Primary) | Alternate Agents | Selection Cue | Invocation | Model Tier | Deliverable Root |\n' +
    '|------|-------------|----------------------|------------------|---------------|------------|------------|------------------|\n' +
    '| developer | | Squad Implementor | | Offline fixture only | subagent | standard | implementation/ |\n');
  write(root + 'consumption.md', 'Synthetic test consumption\n');
  write(root + 'decisions.md', 'Synthetic test decisions\n## Blocking findings\nNo live execution; @someone <script> ![link](unsafe)\n');
  write(root + 'history/autopilot-run-offline-fixture.md', 'Synthetic autopilot history\n');
  write(root + 'history/Squad Implementor.md', '# Synthetic per-role history — no real dispatch\n\n' +
    '#### Consumption\n```json\n' + JSON.stringify({
      model: cfg.model, model_source: 'agent-pinned', priced_as: cfg.model, model_tier: 'standard',
      internal_turns: 0, input_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0,
      basis: 'Offline synthetic fixture, not live consumption or dispatch evidence'
    }, null, 2) + '\n```\n');
  if (options.noState) fs.unlinkSync(root + 'state.json');
}

function requestEnvironment(request, current = request.runAttempt, handoffAttempt = current) {
  write(path.join(process.env.REQUEST_DIR, 'request.json'), JSON.stringify(request));
  process.env.GITHUB_RUN_ID = request.runId;
  process.env.GITHUB_RUN_ATTEMPT = current;
  process.env.EXPECTED_REQUEST_SHA256 = p.digest(p.requestBytes());
  process.env.EXPECTED_REQUEST_ATTEMPT = request.runAttempt;
  process.env.EXPECTED_REQUEST_ARTIFACT = `squad-request-${request.runId}-${request.runAttempt}`;
  process.env.EXPECTED_REQUEST_ARTIFACT_ID = '1001';
  process.env.EXPECTED_HANDOFF_ATTEMPT = handoffAttempt;
  process.env.EXPECTED_HANDOFF_ARTIFACT = `squad-handoff-${request.runId}-${handoffAttempt}`;
  process.env.EXPECTED_HANDOFF_ARTIFACT_ID = '1002';
}

function trustedFixture(request, customize = () => {}) {
  fixtures(request);
  customize();
  p.git(['add', '-A', '--', '.copilot-tracking/']);
  // Tree objects only in the disposable clone: no commits, refs or real squad init.
  const baseSha = p.git(['write-tree']).toString().trim();
  p.git(['reset', '--mixed', 'HEAD'], { stdio: 'ignore' });
  return { ...request, baseSha };
}

function stagedAudit(request) {
  p.git(['add', '-A', '--', '.copilot-tracking/']);
  return p.audit(request);
}

function ignoringAudit(action) {
  const filename = '.git/info/exclude';
  const previous = fs.readFileSync(filename);
  fs.appendFileSync(filename, '\n/.copilot-tracking/squad/\n');
  try { return action(); } finally { fs.writeFileSync(filename, previous); }
}

async function test(name, action) {
  clean();
  try {
    await action();
    passed++;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function run() {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', original, clone],
    { stdio: 'pipe' });
  process.chdir(clone);
  write('.github/squad-watch.json', JSON.stringify(cfg));
  fs.appendFileSync('.git/info/exclude', '\n/.github/squad-watch.json\n/.watch-run/\n');
  const baseSha = p.git(['rev-parse', 'HEAD']).toString().trim();
  const request = {
    schemaVersion: 1, repository: cfg.repository, baseBranch: 'main', baseSha,
    issue: 42, ref: `${cfg.repository}#42`, source: 'issue', eventId: 'issues:142',
    actor: 'Peter-N91', triggeringActor: 'Peter-N91', runId: '123', runAttempt: '1',
    subSquad: 'issue-42', branch: 'squad/issue-42', model: cfg.model, maxAiCredits: cfg.defaultAiCredits
  };
  request.issueHash = p.issueHash(mock(request).issue);
  process.env.TRIGGERING_ACTOR = 'Peter-N91';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  process.env.EXPECTED_BASE_SHA = baseSha;
  process.env.EXPECTED_ISSUE = '42';
  process.env.REQUEST_DIR = path.join(directory, 'request');
  process.env.HANDOFF_DIR = path.join(directory, 'handoff');
  process.env.RESULT_DIR = path.join(directory, 'result');
  requestEnvironment(request);

  await test('approved inputs guard frozen ref drift immediately', () => {
    const manifest = fs.readFileSync(path.join(original, 'apm.yml'));
    const lock = fs.readFileSync(path.join(original, 'apm.lock.yaml'));
    verifyInputs(cfg, manifest, lock);
    assert.throws(() => verifyInputs(cfg,
      Buffer.from(manifest.toString().replace('v0.18.1', 'v0.18.0')), lock));
    assert.throws(() => verifyInputs(cfg, manifest, Buffer.from('altered lock')));
  });
  await test('strict dispatch numbers and shared soft cap', () => {
    for (const value of ['0', '-1', '1.2', '1e2', ' 42', '42 ', '42;echo x', '9007199254740992']) {
      assert.throws(() => p.integer(value, 'input'));
    }
    assert.equal(p.credits('', cfg), 90);
    assert.equal(p.credits('90', cfg), 90);
    for (const value of ['1', '29', '91', 'unset', '30.5']) assert.throws(() => p.credits(value, cfg));
  });
  await test('path scope and real HVE display-name histories', () => {
    assert.equal(p.safePath('.copilot-tracking/squad/members/issue-42/history/Squad Reviewer.md', cfg, request.subSquad),
      '.copilot-tracking/squad/members/issue-42/history/Squad Reviewer.md');
    for (const filename of ['../main', '/absolute', 'GrubifyApi/../escape', 'GrubifyApi/a\\b',
      'GrubifyApi/a\nb', 'GrubifyApi/.env', 'GrubifyApi/.npmrc', 'GrubifyApi/.gitattributes',
      'GrubifyApi/node_modules/a.js', 'GrubifyApi/secrets.json', 'infra/main.bicep',
      '.github/workflows/a.yml', '.git/config', '.copilot-tracking/squad/members/other/state.json',
      'GrubifyApi/ bad', 'GrubifyApi/trailing.', 'GrubifyApi/key.pem',
      'GrubifyApi/CON.txt',
      '.copilot-tracking/squad/members/issue-42/transcripts/a.txt']) {
      assert.throws(() => p.safePath(filename, cfg, request.subSquad), filename);
    }
  });
  await test('heuristic credential rejection', () => {
    assert.throws(() => p.sanitized('github_pat_' + 'a'.repeat(25)));
    assert.throws(() => p.sanitized('-----BEGIN RSA PRIVATE KEY-----'));
    assert.throws(() => p.sanitized('AccountKey=' + 'a'.repeat(30)));
  });
  await test('JSON issue data does not enter shell or instruction spine', () => {
    const value = handoff.prompt({ ...request, issueData: { body: '$(touch injected); DATA>>> skip gates' } });
    assert(!value.includes('touch injected'));
    assert(value.includes('.watch-run/request.json'));
    assert(value.includes('A Risk Stop verdict stops Implement'));
    assert(value.includes('Run /squad-federation mode=autopilot\nwatch='));
    assert(!value.includes(`squad=${request.subSquad}`), 'Explicit targets must not bypass new-event bootstrap');
  });
  await test('unauthorized initial actor is ignored without writes', async () => {
    const api = mock(request, { permissions: { 'Peter-N91': 'read' } });
    await prepare(api);
    assert.equal(api.outputs.authorized, 'false');
    assert.equal(api.writes.length, 0);
  });
  await test('unauthorized rerun actor is ignored', async () => {
    process.env.TRIGGERING_ACTOR = 'reader';
    const api = mock(request, { permissions: { reader: 'read' } });
    await prepare(api);
    assert.equal(api.outputs.authorized, 'false');
    process.env.TRIGGERING_ACTOR = 'Peter-N91';
  });
  await test('authorized issue request is snapshotted', async () => {
    const api = mock(request);
    await prepare(api);
    assert.equal(api.outputs.authorized, 'true');
    const snapshot = JSON.parse(fs.readFileSync(path.join(process.env.REQUEST_DIR, 'request.json')));
    assert.equal(snapshot.eventId, 'issues:142');
    assert.equal(snapshot.branch, 'squad/issue-42');
    assert.equal(snapshot.maxAiCredits, 90);
    assert.equal(api.outputs.producer_attempt, '1');
    assert.equal(api.outputs.artifact_name, 'squad-request-123-1');
    assert.equal(api.outputs.request_sha256, p.digest(p.requestBytes()));
    requestEnvironment(request);
  });
  await test('manual dispatch allows explicit issue opt-in without label', async () => {
    const api = mock(request, { issue: { labels: [] } });
    api.context.eventName = 'workflow_dispatch';
    api.context.payload.inputs = { issue_number: '42', max_ai_credits: '60' };
    await prepare(api);
    assert.equal(api.outputs.authorized, 'true');
    const snapshot = JSON.parse(fs.readFileSync(path.join(process.env.REQUEST_DIR, 'request.json')));
    assert.equal(snapshot.maxAiCredits, 60);
    assert.equal(snapshot.eventId, 'issues:142');
    requestEnvironment(request);
  });
  for (const options of [{ issue: { state: 'closed' } }, { issue: { pull_request: {} } },
    { issue: { labels: [] } }, { baseSha: 'a'.repeat(40) }]) {
    await test('prepare refuses closed/PR/unlabeled/stale target', async () => {
      const api = mock(request, options);
      await assert.rejects(prepare(api));
      assert.equal(api.writes.length, 0);
    });
  }
  await test('manual dispatch refuses a non-main workflow ref', async () => {
    const api = mock(request);
    api.context.ref = 'refs/heads/untrusted';
    await assert.rejects(prepare(api));
  });
  await test('existing branch/PR blocks duplicate AI work', async () => {
    for (const options of [{ existingBranch: true }, { pulls: [{ number: 5 }] }]) {
      const api = mock(request, options);
      await prepare(api);
      assert.equal(api.outputs.authorized, 'false');
      assert.equal(api.writes.length, 0);
    }
  });
  await test('partial interpret rerun keeps request origin and records current producer', async () => {
    requestEnvironment(request, '2');
    process.env.TRIGGERING_ACTOR = 'maintainer';
    await prepare.revalidate(mock(request));
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    const manifest = JSON.parse(fs.readFileSync(path.join(process.env.HANDOFF_DIR, 'handoff.json')));
    assert.equal(manifest.requestRunAttempt, '1');
    assert.equal(manifest.runAttempt, '2');
    assert.equal(manifest.triggeringActor, 'maintainer');
    assert.equal(manifest.requestSha256, process.env.EXPECTED_REQUEST_SHA256);
    clean();
    const api = mock(request);
    await apply(api);
    assert.equal(api.outputs.status, 'draft-created');
    process.env.TRIGGERING_ACTOR = 'Peter-N91';
    requestEnvironment(request);
  });
  await test('apply-only rerun downloads the earlier interpretation producer', async () => {
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    requestEnvironment(request, '3', '1');
    process.env.TRIGGERING_ACTOR = 'maintainer';
    const api = mock(request);
    await apply(api);
    assert.equal(api.outputs.status, 'draft-created');
    process.env.TRIGGERING_ACTOR = 'Peter-N91';
    requestEnvironment(request);
  });
  await test('full rerun prepares a new origin for both artifacts', async () => {
    process.env.GITHUB_RUN_ATTEMPT = '4';
    process.env.TRIGGERING_ACTOR = 'maintainer';
    const api = mock(request);
    await prepare(api);
    const fresh = JSON.parse(p.requestBytes());
    assert.equal(fresh.runAttempt, '4');
    assert.equal(fresh.triggeringActor, 'maintainer');
    assert.equal(api.outputs.artifact_name, 'squad-request-123-4');
    requestEnvironment(fresh);
    await prepare.revalidate(mock(fresh));
    fixtures(fresh);
    handoff.stage(fresh, cfg, process.env.HANDOFF_DIR);
    const manifest = JSON.parse(fs.readFileSync(path.join(process.env.HANDOFF_DIR, 'handoff.json')));
    assert.equal(manifest.requestRunAttempt, '4');
    assert.equal(manifest.runAttempt, '4');
    clean();
    const mutation = mock(fresh);
    await apply(mutation);
    assert.equal(mutation.outputs.status, 'draft-created');
    process.env.TRIGGERING_ACTOR = 'Peter-N91';
    requestEnvironment(request);
  });
  await test('unauthorized partial rerun is rejected before interpretation and mutation', async () => {
    requestEnvironment(request, '2', '1');
    process.env.TRIGGERING_ACTOR = 'reader';
    const api = mock(request, { permissions: { reader: 'read' } });
    await assert.rejects(prepare.revalidate(api), /authorization/);
    await assert.rejects(apply(api), /authorization/);
    assert.equal(api.writes.length, 0);
    process.env.TRIGGERING_ACTOR = 'Peter-N91';
    requestEnvironment(request);
  });
  await test('stale issue/main and existing work are rejected before model work', async () => {
    for (const options of [{ issue: { title: 'Changed' } }, { baseSha: 'a'.repeat(40) },
      { issue: { labels: [] } }, { existingBranch: true }, { pulls: [{ number: 5 }] }]) {
      const api = mock(request, options);
      await assert.rejects(prepare.revalidate(api));
      assert.equal(api.writes.length, 0);
    }
  });
  await test('wrong request producer identity or immutable hash is rejected before model', async () => {
    for (const [key, value] of [['EXPECTED_REQUEST_ATTEMPT', '2'],
      ['EXPECTED_REQUEST_ARTIFACT', 'squad-request-123-2'], ['EXPECTED_REQUEST_ARTIFACT_ID', 'invalid'],
      ['EXPECTED_REQUEST_SHA256', 'a'.repeat(64)]]) {
      const old = process.env[key];
      process.env[key] = value;
      await assert.rejects(prepare.revalidate(mock(request)));
      process.env[key] = old;
    }
  });
  await test('all execution/producer attempts are structurally validated', async () => {
    for (const bad of ['0', '01', '1.5', '1e1', ' 1', '9007199254740992']) {
      for (const key of ['GITHUB_RUN_ATTEMPT', 'EXPECTED_REQUEST_ATTEMPT']) {
        const old = process.env[key];
        process.env[key] = bad;
        await assert.rejects(prepare.revalidate(mock(request)), /attempt/);
        process.env[key] = old;
      }
      requestEnvironment({ ...request, runAttempt: bad }, '2');
      await assert.rejects(prepare.revalidate(mock(request)), /attempt/);
      requestEnvironment(request);
    }
  });
  await test('missing squad audit fails closed', () => {
    fixtures(request, { noState: true });
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
  });
  await test('real Git ignored-state failure reproduces then scoped staging and independent apply succeed', () => {
    fixtures(request);
    ignoringAudit(() => {
      const oldPaths = p.git(['ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z'])
        .toString().split('\0').filter(Boolean);
      assert.deepEqual(oldPaths, ['GrubifyApi/watch-contract-fixture.txt']);
      p.git(['add', '-A', '--', ...oldPaths]);
      assert.throws(() => p.git(['show', ':.copilot-tracking/squad/federation.md']),
        error => error.status === 128 && /unknown revision or path|not in the index/.test(error.stderr.toString()));
      const before = diagnostics.report(request.subSquad, 'success', 'failure', '0');
      assert.equal(before.classification, 'incomplete-audit');
      assert.deepEqual(before.auditPresence.federation, { disk: 'regular', index: false });
      p.git(['read-tree', 'HEAD']);
      // These are not audit candidates, even when the whole federation is ignored.
      write('.copilot-tracking/squad/members/other/secrets.json', 'Never include other members\n');
      write('.copilot-tracking/squad/logs/private.log', 'Never include runtime logs\n');
      handoff.stage(request, cfg, process.env.HANDOFF_DIR);
      const manifest = JSON.parse(fs.readFileSync(path.join(process.env.HANDOFF_DIR, 'handoff.json')));
      assert(manifest.files.some(file => file.path === '.copilot-tracking/squad/federation.md'));
      assert(!manifest.files.some(file => /other|private\.log/.test(file.path)));
      assert.equal(diagnostics.report(request.subSquad, 'success', 'success', '0').classification,
        'validated-handoff');
    });
    clean();
    const result = apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR);
    assert(result.changes.length > 1);
    assert.equal(result.audit.run, 'autopilot-run-offline-fixture');
  });
  await test('source-only success cannot bypass incomplete bootstrap', () => {
    write('GrubifyApi/watch-contract-fixture.txt', 'Source alone is not a Squad run\n');
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR),
      error => error.code === 'SQUAD_AUDIT_INCOMPLETE' && !error.message.includes('Buffer'));
    const result = diagnostics.report(request.subSquad, 'success', 'failure', '0');
    assert.equal(result.auditPresence.federation.disk, 'absent');
    assert.equal(result.classification, 'incomplete-audit');
    assert(!JSON.stringify(result).includes('Source alone'));
  });
  for (const filename of ['secrets.json', 'logs/private.txt', 'session/raw.md', 'credentials.txt']) {
    await test(`ignored current-member ${filename} is refused before staging`, () => {
      fixtures(request);
      write(`.copilot-tracking/squad/members/${request.subSquad}/${filename}`, 'Unpublishable\n');
      ignoringAudit(() => assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR)));
      assert.equal(p.git(['diff', '--cached', '--name-only']).length, 0);
    });
  }
  await test('ignored audit file size and traversal count are bounded before staging', () => {
    fixtures(request);
    ignoringAudit(() => {
      write(`.copilot-tracking/squad/members/${request.subSquad}/oversized.md`,
        Buffer.alloc(cfg.maximumFileBytes + 1, 'a'));
      assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /size bound/);
      assert.equal(p.git(['diff', '--cached', '--name-only']).length, 0);
      fs.unlinkSync(`.copilot-tracking/squad/members/${request.subSquad}/oversized.md`);
      for (let i = 0; i < cfg.maximumFiles + 1; i++) {
        write(`.copilot-tracking/squad/members/${request.subSquad}/entry-${i}.md`, 'Bounded\n');
      }
      assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /Too many/);
    });
  });
  await test('ignored event directory symlink is refused without reading its target', () => {
    fixtures(request);
    const directory = `.copilot-tracking/squad/members/${request.subSquad}/linked`;
    const target = path.join(clone, '.watch-run', 'private-fixture');
    write(path.join(target, 'hidden.md'), 'Not audit evidence\n');
    fs.symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
    ignoringAudit(() => assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /Symlink/));
    assert.equal(fs.readFileSync(path.join(target, 'hidden.md'), 'utf8'), 'Not audit evidence\n');
    fs.rmSync(directory, { recursive: true });
  });
  await test('safe diagnostic output rejects arbitrary outcome and exit text', () => {
    const result = diagnostics.report(request.subSquad, '::error::private-input', '<script>', '999\nsecret');
    assert.equal(result.modelStep, 'unknown');
    assert.equal(result.handoffStep, 'unknown');
    assert.equal(result.cliExitCode, null);
    assert(!JSON.stringify(result).includes('private-input'));
    assert.equal(diagnostics.report(request.subSquad, 'failure', 'skipped', '124').termination,
      'timeout-or-killed');
    assert.equal(diagnostics.report(request.subSquad, 'failure', 'skipped', '1').termination,
      'nonzero-exit');
    assert(!diagnostics.stageError(Object.assign(new Error('secret'), { status: 128 })).includes('secret'));
    assert(!diagnostics.stageError(new Error('secret')).includes('secret'));
  });
  await test('trusted diagnostic entrypoint persists only fixed safe metadata after failure', () => {
    const destination = path.join(clone, '.watch-run', 'safe-diagnostic');
    const summary = path.join(clone, '.watch-run', 'summary');
    execFileSync(process.execPath, [path.join(original, 'scripts', 'squad-watch', 'diagnostics.cjs')], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        AUDIT_MEMBER: request.subSquad, MODEL_OUTCOME: 'success', HANDOFF_OUTCOME: 'failure',
        CLI_EXIT_CODE: '0', DIAGNOSTIC_DIR: destination, GITHUB_STEP_SUMMARY: summary },
      stdio: 'pipe'
    });
    const result = JSON.parse(fs.readFileSync(path.join(destination, 'runtime-status.json')));
    assert.equal(result.classification, 'incomplete-audit');
    assert.equal(result.cliExitCode, 0);
    assert.equal(result.auditPresence.memberState.disk, 'absent');
    assert.deepEqual(fs.readdirSync(destination), ['runtime-status.json']);
    assert(fs.readFileSync(summary, 'utf8').includes('Credit exhaustion'));
  });
  if (process.platform !== 'win32') {
    for (const script of ['run-squad.sh', 'run-review.sh']) {
      await test(`${script} real Bash boundary records exit without leaking raw output (mock CLI, no AI)`, () => {
        const bin = path.join(clone, '.watch-run', 'mock-bin');
        const output = path.join(clone, '.watch-run', 'outputs');
        write('.watch-run/request.json', JSON.stringify(request));
        write('.watch-run/prompt.txt', 'Offline fixture, never a real model request\n');
        const wrapper = path.join(clone, '.watch-run', 'runtime-fixture.sh');
        write(wrapper, fs.readFileSync(path.join(original, 'scripts', 'squad-watch', script), 'utf8')
          .replace(/\r\n/g, '\n'));
        write(path.join(bin, 'copilot'), '#!/bin/bash\nprintf \"private fixture text must not escape\\\\n\" >&2\nexit \"$FIXTURE_EXIT\"\n');
        fs.chmodSync(path.join(bin, 'copilot'), 0o755);
        for (const code of [0, 7, 124]) {
          write(output, '');
          let stdout;
          try {
            stdout = execFileSync('bash', [wrapper], {
              env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
                HOME: path.join(clone, '.watch-run'), COPILOT_GITHUB_TOKEN: 'offline-dummy-not-a-credential',
                GITHUB_OUTPUT: output, FIXTURE_EXIT: String(code) }, stdio: 'pipe'
            }).toString();
            assert.equal(code, 0);
          } catch (error) {
            assert.equal(error.status, code);
            stdout = error.stdout.toString() + error.stderr.toString();
          }
          assert(!stdout.includes('private fixture text'));
          assert.equal(fs.readFileSync(output, 'utf8'), `cli_exit_code=${code}\n`);
        }
      });
    }
  }
  await test('forbidden changes are rejected, not silently omitted', () => {
    write('infra/unauthorized.txt', 'no');
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
  });
  await test('secrets in proposed content are rejected', () => {
    fixtures(request, { content: 'github_pat_' + 'x'.repeat(30) });
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
  });
  await test('human-owned federation member is never adopted', () => {
    fixtures(request);
    const file = '.copilot-tracking/squad/federation.md';
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('watch-mode', 'human-owner'));
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
  });
  await test('forged event provenance is rejected', () => {
    fixtures(request);
    const file = `.copilot-tracking/squad/members/${request.subSquad}/state.json`;
    const state = JSON.parse(fs.readFileSync(file));
    state.trigger.eventId = 'issues:999';
    fs.writeFileSync(file, JSON.stringify(state));
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
  });
  await test('blank federation initialization accepts scoped registry routing and state', () => {
    fixtures(request);
    write('.copilot-tracking/squad/meta-routing.md',
      `| Pattern / Domain | Sub-squad | Parallel-Eligible |\n| watch: ${request.ref} | ${request.subSquad} | no |\n`);
    write('.copilot-tracking/squad/state.json', JSON.stringify({
      schemaVersion: '1.3', turn: 1, subSquads: [request.subSquad],
      activeSubSquads: [request.subSquad], openEscalations: []
    }));
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    assert(apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR).changes.length > 0);
  });
  await test('trusted human ownership cannot be relabeled by proposed registry', () => {
    const owned = trustedFixture(request, () => {
      const file = '.copilot-tracking/squad/federation.md';
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('watch-mode', 'human-owner'));
    });
    fixtures(request);
    assert.throws(() => stagedAudit(owned), /Trusted base member/);
  });
  await test('trusted event ref or event ID cannot be replaced with approved provenance', () => {
    for (const field of ['ref', 'eventId']) {
      clean();
      const prior = trustedFixture(request, () => {
        const file = `.copilot-tracking/squad/members/${request.subSquad}/state.json`;
        const state = JSON.parse(fs.readFileSync(file));
        state.trigger[field] = 'other-event';
        write(file, JSON.stringify(state));
      });
      fixtures(request);
      assert.throws(() => stagedAudit(prior), /trusted provenance/);
    }
  });
  await test('unrelated federation registry deletions mutations additions are refused', () => {
    for (const attack of ['delete', 'mutate', 'add']) {
      clean();
      const file = '.copilot-tracking/squad/federation.md';
      const row = '| product | product | in-repo | members/product/ | human | Roadmap |\n';
      const prior = trustedFixture(request, () => fs.appendFileSync(file, row));
      const value = fs.readFileSync(file, 'utf8');
      write(file, attack === 'delete' ? value.replace(row, '') :
        attack === 'mutate' ? value.replace('Roadmap', 'Hijacked') :
          value + '| other | default | in-repo | members/other/ | watch-mode | Not this event |\n');
      assert.throws(() => stagedAudit(prior), /shared audit/);
    }
  });
  await test('owned member resume preserves unrelated rows and histories while appending', () => {
    const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
    const prior = trustedFixture(request, () => {
      fs.appendFileSync('.copilot-tracking/squad/federation.md',
        '| product | product | in-repo | members/product/ | human | Roadmap |\n');
      write('.copilot-tracking/squad/members/product/history/prior.md', 'Unrelated history\n');
    });
    fs.appendFileSync(root + 'history/Squad Implementor.md', 'New dispatch\n');
    fs.appendFileSync(root + 'decisions.md', '\nNew decision\n');
    const state = JSON.parse(fs.readFileSync(root + 'state.json'));
    state.updated = '2026-10-09';
    write(root + 'state.json', JSON.stringify(state));
    assert.equal(stagedAudit(prior).run, 'autopilot-run-offline-fixture');
  });
  await test('matching orphan member may re-register but unproven orphan cannot', () => {
    for (const matches of [true, false]) {
      clean();
      const prior = trustedFixture(request, () => {
        fs.unlinkSync('.copilot-tracking/squad/federation.md');
        if (!matches) fs.unlinkSync(`.copilot-tracking/squad/members/${request.subSquad}/state.json`);
      });
      fixtures(request);
      if (matches) assert(stagedAudit(prior));
      else assert.throws(() => stagedAudit(prior), /lacks trusted provenance/);
    }
  });
  await test('same-member histories cannot be overwritten reordered or truncated', () => {
    for (const attack of ['overwritten', 'reordered', 'truncated']) {
      clean();
      const file = `.copilot-tracking/squad/members/${request.subSquad}/history/Squad Implementor.md`;
      const prior = trustedFixture(request, () => write(file, 'First dispatch\nSecond dispatch\n'));
      write(file, attack === 'overwritten' ? 'Forged dispatch\n' :
        attack === 'reordered' ? 'Second dispatch\nFirst dispatch\n' : 'First dispatch\n');
      assert.throws(() => stagedAudit(prior), /Append-only/);
    }
  });
  await test('shared routing and metadata cannot hijack unrelated registrations', () => {
    const routing = '.copilot-tracking/squad/meta-routing.md';
    const stateFile = '.copilot-tracking/squad/state.json';
    const prior = trustedFixture(request, () => {
      fs.appendFileSync('.copilot-tracking/squad/federation.md',
        '| product | product | in-repo | members/product/ | human | Roadmap |\n');
      write(routing, `| Pattern / Domain | Sub-squad | Parallel-Eligible |\n| roadmap | product | yes |\n| discovery | product | yes |\n| watch: ${request.ref} | ${request.subSquad} | no |\n`);
      write(stateFile, JSON.stringify({ schemaVersion: '1.3', turn: 1,
        subSquads: ['product', request.subSquad], activeSubSquads: ['product'],
        notify: { enabled: false }, currentRun: { estCostUsd: 5 }, openEscalations: ['prior'] }));
    });
    const originalRoute = fs.readFileSync(routing);
    const originalState = fs.readFileSync(stateFile);
    write(routing, originalRoute.toString().replace('roadmap', 'hijacked'));
    assert.throws(() => stagedAudit(prior), /shared audit/);
    write(routing, originalRoute);
    for (const mutation of [
      state => { state.subSquads = [request.subSquad]; },
      state => { state.openEscalations = []; },
      state => { state.notify.enabled = true; },
      state => { state.currentRun.estCostUsd = 0; },
      state => { state.activeSubSquads = [request.subSquad]; }
    ]) {
      const state = JSON.parse(originalState);
      mutation(state);
      write(stateFile, JSON.stringify(state));
      assert.throws(() => stagedAudit(prior), /shared|Unrelated/);
    }
    const next = JSON.parse(originalState);
    next.turn++;
    next.activeSubSquads.push(request.subSquad);
    write(stateFile, JSON.stringify(next));
    assert(stagedAudit(prior));
  });
  await test('current member trigger cannot target another sub-squad', () => {
    fixtures(request);
    const filename = `.copilot-tracking/squad/members/${request.subSquad}/state.json`;
    const state = JSON.parse(fs.readFileSync(filename));
    state.trigger.sub = 'product';
    write(filename, JSON.stringify(state));
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /trigger provenance/);
  });
  await test('resume reports latest blocking findings without rewriting earlier audit', () => {
    const filename = `.copilot-tracking/squad/members/${request.subSquad}/decisions.md`;
    const prior = trustedFixture(request);
    const bytes = fs.readFileSync(filename);
    fs.appendFileSync(filename, '\n## New attempt\nAdditional evidence\n## Blocking findings\nLatest pending human validation\n');
    const result = stagedAudit(prior);
    assert.equal(result.findings, 'Latest pending human validation');
    assert(fs.readFileSync(filename).subarray(0, bytes.length).equals(bytes));
  });
  for (const mode of ['100755', '120000', '160000', 'binary', 'forbidden']) {
    await test('untrusted patch mode/binary/path is independently denied', () => {
      const filename = mode === 'forbidden' ? '.github/unsafe.txt' : 'GrubifyApi/unsafe.txt';
      if (mode === 'binary') {
        write(filename, Buffer.from([0, 1, 2, 3]));
        p.git(['add', '--', filename]);
      } else {
        const sha = mode === '160000' ? baseSha :
          p.git(['hash-object', '-w', '--stdin'], { input: 'offline fixture\n' }).toString().trim();
        p.git(['update-index', '--add', '--cacheinfo', mode === 'forbidden' ? '100644' : mode, sha, filename]);
      }
      const patch = p.git(['diff', '--cached', '--binary', '--no-renames', '--no-ext-diff', '--no-textconv']);
      write(path.join(process.env.HANDOFF_DIR, 'squad-watch.patch'), patch);
      write(path.join(process.env.HANDOFF_DIR, 'handoff.json'), JSON.stringify({
        schemaVersion: 1, ...p.execution(request), status: 'changed', baseSha, issue: 42, subSquad: 'issue-42',
        patchSha256: p.digest(patch), files: []
      }));
      clean();
      assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR));
    });
  }
  await test('complete offline handoff produces only a create-only draft contract', async () => {
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    const api = mock(request);
    await apply(api);
    assert.equal(api.outputs.status, 'draft-created');
    const ref = api.writes.find(([kind]) => kind === 'ref')[1];
    const pr = api.writes.find(([kind]) => kind === 'pr')[1];
    assert.equal(ref.ref, 'refs/heads/squad/issue-42');
    assert.equal(pr.draft, true);
    assert.deepEqual(api.writes.find(([kind]) => kind === 'label')[1],
      { ...api.context.repo, issue_number: 7, labels: ['squad/review'] });
    const result = JSON.parse(fs.readFileSync(path.join(process.env.RESULT_DIR, 'result.json')));
    assert.equal(result.pr, 7);
    assert.equal(result.headSha, 'c'.repeat(40));
    assert.equal(result.sourceRunId, '123');
    assert.equal(api.outputs.result_sha256, p.digest(fs.readFileSync(path.join(process.env.RESULT_DIR, 'result.json'))));
    assert.equal(pr.base, 'main');
    assert(pr.body.includes('Closes #42'));
    assert(pr.body.includes('## Blocking findings'));
    assert(pr.body.includes('\\@someone'));
    assert(pr.body.includes('\\<script\\>'));
    const commit = api.writes.find(([kind]) => kind === 'commit')[1];
    assert.deepEqual(commit.parents, [baseSha]);
    assert(api.writes.findIndex(([kind]) => kind === 'ref') < api.writes.findIndex(([kind]) => kind === 'pr'));
  });
  await test('label failure retains draft and fails with explicit recovery link', async () => {
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    const api = mock(request, { labelFailure: true });
    await assert.rejects(apply(api), /pull\/7.*labeling failed/);
    assert.equal(api.outputs.status, undefined);
    assert.equal(api.writes.filter(([kind]) => kind === 'pr').length, 1);
  });
  await test('wrong handoff producer or origin provenance is independently refused', () => {
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    const filename = path.join(process.env.HANDOFF_DIR, 'handoff.json');
    const bytes = fs.readFileSync(filename);
    for (const [key, value] of [['runAttempt', '2'], ['runAttempt', '01'], ['requestRunAttempt', '2'],
      ['requestSha256', 'b'.repeat(64)], ['requestArtifactId', 'other'],
      ['requestArtifact', 'squad-request-999-1'], ['runId', '999']]) {
      write(filename, JSON.stringify({ ...JSON.parse(bytes), [key]: value }));
      assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR), /provenance|attempt/);
    }
    write(filename, bytes);
    for (const bad of ['0', '1e1', '9007199254740992']) {
      process.env.EXPECTED_HANDOFF_ATTEMPT = bad;
      assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR), /attempt/);
    }
    requestEnvironment(request);
  });
  await test('authorization is checked again immediately before API mutation', async () => {
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    const api = mock(request);
    let checks = 0;
    api.github.rest.repos.getCollaboratorPermissionLevel = async () =>
      ({ data: { permission: ++checks === 1 ? 'write' : 'read' } });
    await assert.rejects(apply(api), /authorization/);
    assert.equal(checks, 2);
    assert.equal(api.writes.length, 0);
  });
  for (const options of [{ issue: { title: 'Edited after opt-in' } }, { issue: { state: 'closed' } },
    { issue: { labels: [] } }, { baseSha: 'b'.repeat(40) },
    { permissions: { 'Peter-N91': 'read' } }, { existingBranch: true }, { pulls: [{ number: 5 }] }]) {
    await test('apply rechecks issue/auth/main/idempotency before any API writes', async () => {
      const api = mock(request, options);
      await assert.rejects(apply(api));
      assert.equal(api.writes.length, 0);
    });
  }
  await test('artifact checksum tampering is rejected', () => {
    const filename = path.join(process.env.HANDOFF_DIR, 'squad-watch.patch');
    const patch = fs.readFileSync(filename);
    fs.appendFileSync(filename, '\nmalicious');
    assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR));
    fs.writeFileSync(filename, patch);
  });
  await test('extra artifact files are rejected', () => {
    const filename = path.join(process.env.HANDOFF_DIR, 'unexpected');
    write(filename, 'no');
    assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR));
    fs.unlinkSync(filename);
  });
  await test('manifest/index mismatch is rejected', () => {
    const filename = path.join(process.env.HANDOFF_DIR, 'handoff.json');
    const manifest = fs.readFileSync(filename);
    const modified = JSON.parse(manifest);
    modified.files[0].path = 'infra/escape.txt';
    fs.writeFileSync(filename, JSON.stringify(modified));
    assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR));
    fs.writeFileSync(filename, manifest);
  });
  await test('API ref race cannot overwrite an existing branch or open a PR', async () => {
    const api = mock(request, { refRace: true });
    await assert.rejects(apply(api));
    assert.equal(api.writes.filter(([kind]) => kind === 'ref').length, 1);
    assert.equal(api.writes.filter(([kind]) => kind === 'pr').length, 0);
  });
  await test('empty coordinator output is incomplete, never a successful no-change bootstrap', () => {
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR),
      error => error.code === 'SQUAD_AUDIT_INCOMPLETE');
  });
  await test('independent apply also rejects a no-change artifact with missing audit', () => {
    write(path.join(process.env.HANDOFF_DIR, 'squad-watch.patch'), '');
    write(path.join(process.env.HANDOFF_DIR, 'handoff.json'), JSON.stringify({
      schemaVersion: 1, ...p.execution(request), status: 'no-change', baseSha,
      issue: request.issue, subSquad: request.subSquad, patchSha256: p.digest(''), files: []
    }));
    assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR),
      error => error.code === 'SQUAD_AUDIT_INCOMPLETE');
  });

  const workflow = fs.readFileSync(path.join(original, '.github/workflows/squad-watch.yml'), 'utf8');
  assert(workflow.includes("vars.SQUAD_WATCH_ENABLED == 'true'"));
  assert(workflow.includes('blank uses 90'));
  assert(!/^\s*(push|schedule|pull_request_target|pull_request|issue_comment|workflow_run):/m.test(workflow));
  for (const match of workflow.matchAll(/uses:\s+(\S+)/g)) assert(/@[0-9a-f]{40}$/.test(match[1]));
  const interpreter = workflow.split('\n  interpret:')[1].split('\n  apply:')[0];
  assert(!/^\s+(?:contents|issues|pull-requests): write$/m.test(interpreter));
  assert(!/secrets\.(?!COPILOT_GITHUB_TOKEN\b)/.test(interpreter));
  assert(interpreter.includes('persist-credentials: false'));
  assert(interpreter.includes("if: always() && steps.coordinator.outcome != 'skipped'"));
  assert(interpreter.includes('/squad-diagnostics/runtime-status.json'));
  assert(!interpreter.includes('copilot-home/'));
  assert(interpreter.indexOf('await prepare.revalidate(') < interpreter.indexOf('secrets.COPILOT_GITHUB_TOKEN'));
  assert(interpreter.includes('artifact-ids: ${{ needs.prepare.outputs.request_artifact_id }}'));
  assert(workflow.includes('artifact-ids: ${{ needs.interpret.outputs.handoff_artifact_id }}'));
  assert(!workflow.includes('squad-request-${{ github.run_id }}-${{ github.run_attempt }}'));
  const mutation = fs.readFileSync(path.join(original, 'scripts/squad-watch/apply.cjs'), 'utf8');
  assert(!/\bupdateRef\s*\(|\bexecFileSync\s*\(|\bgit push\b/.test(mutation));
  console.log(`Passed ${passed} offline consumer contract cases plus workflow SHA/trigger/permission assertions. No AI or remote mutations executed.`);
}

run().finally(() => {
  process.chdir(original);
  fs.rmSync(directory, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
