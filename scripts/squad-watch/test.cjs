'use strict';

// Offline contract tests only. Synthetic audit fixtures stay in a disposable,
// local clone under .watch-validation; they never initialize the real squad.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const p = require('./policy.cjs');
const prepare = require('./prepare.cjs');
const handoff = require('./handoff.cjs');
const diagnostics = require('./diagnostics.cjs');
const apply = require('./apply.cjs');
const pipeline = require('./pipeline.cjs');
const runtime = require('./runtime.cjs');
const completion = require('./completion-gate.cjs');
const progress = require('./progress.cjs');
const { pipelineFixture, consumptionFixture, consumptionBlock, completionFixture } = require('./test-fixtures.cjs');
const { verifyInputs } = require('./check-apm.cjs');
const original = process.cwd();
const cfg = p.config();
fs.mkdirSync(path.join(original, '.watch-validation'), { recursive: true });
const directory = fs.mkdtempSync(path.join(original, '.watch-validation', `contracts-${process.platform}-${process.pid}-`));
const clone = path.join(directory, 'checkout');
let passed = 0;

function write(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function creditEvent(totalNanoAiu, status, type = 'session.usage_checkpoint') {
  return { type, data: { totalNanoAiu, ...(type === 'session.shutdown' ? { shutdownType: 'error' } : {}),
    ...(status === undefined ? {} : { accountingSnapshot: { totalNanoAiu, aiCreditsStatus: status } }) } };
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
    consumptionBlock());
  if (options.noState) fs.unlinkSync(root + 'state.json');
  pipelineFixture(request, write);
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
    subSquad: 'issue-42', branch: 'squad/issue-42', model: cfg.model,
    maxAiCredits: cfg.defaultAiCredits, uncappedDiagnostic: false
  };
  request.issueHash = p.issueHash(mock(request).issue);
  process.env.TRIGGERING_ACTOR = 'Peter-N91';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  process.env.EXPECTED_BASE_SHA = baseSha;
  process.env.EXPECTED_ISSUE = '42';
  process.env.REQUEST_DIR = path.join(directory, 'request');
  process.env.HANDOFF_DIR = path.join(directory, 'handoff');
  process.env.RESULT_DIR = path.join(directory, 'result');
  process.env.RUNNER_TEMP = path.join(directory, 'runner');
  requestEnvironment(request);

  await test('shared bootstrap requires only phase-correct scoped initialization, never future history', () => {
    const contract = p.watchAuditContract(request).join('\n');
    const init = contract.split('PHASE 2')[0];
    assert(init.includes('Bootstrap does NOT require future role histories'));
    assert(init.includes('exactly ONE payloadType and ONE'));
    assert(init.includes('separate payloadType initialization'));
    assert(init.includes('immediately dispatch Research'));
    assert(!init.includes('history/autopilot-run-<id>.md'));
    assert(pipeline.prompt(request).join('\n').includes('at least SIX'));
  });
  await test('bootstrap-only missing role history fails final handoff but root hook continues Research', () => {
    fixtures(request);
    const { root } = pipelineFixture(request, write);
    fs.unlinkSync(root + 'pipeline.json');
    for (const [, agent] of pipeline.stages) fs.unlinkSync(root + `history/${agent}.md`);
    const scribe = fs.readFileSync(root + 'history/Squad Scribe.md');
    fs.unlinkSync(root + 'history/Squad Scribe.md');
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /Missing per-role dispatch history/);
    const failed = diagnostics.report(request.subSquad, 'success', 'failure', '0');
    assert(Object.values(failed.auditPresence).every(value => value.disk === 'regular' && value.index));
    assert.equal(failed.roleHistory['Squad Scribe'], 'absent');
    write(root + 'history/Squad Scribe.md', scribe);
    p.git(['read-tree', 'HEAD']);
    completionFixture(request, write, ({ input, native, events }) => {
      native(events(['hve-squad:squad-scribe', 'hve-squad:squad-scribe']));
      const result = completion.evaluate(input);
      assert.equal(result.decision, 'block');
      assert(result.reason.includes('next actual Research'));
      assert(!result.reason.includes('reinitialize'));
      const report = diagnostics.report(request.subSquad, 'success', 'failure', '0');
      assert.equal(report.native.completed['Squad Scribe'], 2);
      assert.equal(report.native.completed['Squad Researcher'], 0);
      assert.equal(report.roleHistory['Squad Researcher'], 'absent');
      assert.equal(report.pipeline.availability, 'absent');
      assert.equal(report.completionHook.blocks, 1);
    });
  });
  await test('missing member Scribe initialization asks only for member scope, not fabricated future history', () => {
    fixtures(request);
    const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
    fs.unlinkSync(root + 'history/Squad Scribe.md');
    completionFixture(request, write, ({ input, native, events }) => {
      native(events(['hve-squad:squad-scribe']));
      assert(completion.evaluate(input).reason.includes('member-scoped initialization'));
      fs.unlinkSync('.copilot-tracking/squad/federation.md');
      assert(completion.evaluate(input).reason.includes('federation-scoped'));
    });
  });
  await test('a natural stop before any child requests real bootstrap, never accepts empty native proof', () => {
    completionFixture(request, write, ({ input, native }) => {
      native([{ type: 'session.start', data: {} }, { type: 'assistant.message', data: { content: 'private' } }]);
      assert(completion.evaluate(input).reason.includes('federation-scoped Scribe initialization'));
      assert.equal(progress.inspect(request.subSquad, progress.context()).native.availability, 'incomplete');
    });
  });
  await test('actual completed Research without Scribe evidence asks handoff, never repeats Research', () => {
    fixtures(request);
    const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
    fs.unlinkSync(root + 'pipeline.json');
    fs.unlinkSync(root + 'history/Squad Researcher.md');
    fs.unlinkSync(root + 'history/Squad Scribe.md');
    completionFixture(request, write, ({ input, native, events }) => {
      native(events(['hve-squad:squad-scribe', 'hve-squad:squad-scribe', 'hve-squad:squad-researcher']));
      const result = completion.evaluate(input);
      assert(result.reason.includes('actual Research role already completed'));
      assert(result.reason.includes('payloadType history'));
      assert(result.reason.includes('history/Squad Researcher.md'));
      assert(result.reason.includes('history/Squad Scribe.md'));
      assert(result.reason.includes('Do not reinitialize'));
      assert(!result.reason.includes('next actual Research'));
    });
  });
  await test('serialized verified Research advances Plan, malformed consumption requests Scribe repair', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native, events }) => {
      native(events(['hve-squad:squad-scribe', 'hve-squad:squad-researcher', 'hve-squad:squad-scribe']));
      assert(completion.evaluate(input).reason.includes('next actual Plan'));
      write(`.copilot-tracking/squad/members/${request.subSquad}/history/Squad Researcher.md`,
        'Research research/pipeline-fixture.txt without consumption');
      assert(completion.evaluate(input).reason.includes('actual Research role already completed'));
    });
  });
  await test('complete native four-stage evidence allows root stop without mutating Git or Squad files', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native }) => {
      const { events } = pipelineFixture(request, write);
      native(events);
      const before = p.git(['diff', '--binary']).toString();
      const index = fs.readFileSync('.git/index');
      const audit = p.proposalPaths(cfg, request.subSquad).sort().map(file =>
        [file, p.digest(fs.readFileSync(file))]);
      assert.deepEqual(completion.evaluate(input), {});
      assert.equal(p.git(['diff', '--binary']).toString(), before);
      assert(fs.readFileSync('.git/index').equals(index));
      assert.deepEqual(audit, p.proposalPaths(cfg, request.subSquad).sort().map(file =>
        [file, p.digest(fs.readFileSync(file))]));
      assert.equal(progress.hookStats().status, 'complete');
    });
  });
  await test('valid actual blocked prefix permits stop while source authorization still denies Implement', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native }) => {
      const { journal, events, root } = pipelineFixture(request, write);
      journal.status = 'blocked';
      journal.blockingReason = 'Synthetic genuine Risk Stop';
      journal.stages = journal.stages.slice(0, 1);
      write(root + 'pipeline.json', JSON.stringify(journal));
      native(events.slice(0, 6));
      assert.deepEqual(completion.evaluate(input), {});
      assert.equal(progress.hookStats().status, 'blocked');
      assert.throws(() => pipeline.sourceGate(request, journal, [{ path: 'GrubifyApi/source.cs' }]),
        /completed Implement/);
    });
  });
  await test('recorded gates and invalid blocked prefixes never cause a new domain dispatch', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native, events }) => {
      native(events(['hve-squad:squad-scribe']));
      const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
      write(root + 'decisions.md', '## Blocking findings\n\nRisk Stop: actual unresolved gate\n');
      fs.unlinkSync(root + 'pipeline.json');
      assert(completion.evaluate(input).reason.includes('Preserve the declared block'));
      write(root + 'pipeline.json', JSON.stringify({ status: 'blocked', stages: [] }));
      assert(completion.evaluate(input).reason.includes('Do NOT dispatch another domain role'));
    });
  });
  await test('missing unsupported failed cancelled or overlapping native evidence cannot accept artifact completion', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native, events, filename }) => {
      for (const value of [null, [{ type: 'subagent.completed', data: {} }],
        [{ type: 'subagent.failed' }], [...events(['hve-squad:squad-scribe']),
          { type: 'subagent.started', data: { toolCallId: 'bad', agentName: 'squad-lead' } }],
        [{ type: 'subagent.started', data: { toolCallId: 'bad', agentName: 'squad-scribe' } },
          { type: 'subagent.completed', data: { toolCallId: 'bad', cancelled: true } }]]) {
        fs.rmSync(path.join(process.env.RUNNER_TEMP, 'squad-runtime', 'completion-status.json'), { force: true });
        if (value) native(value); else fs.rmSync(filename, { force: true });
        const result = completion.evaluate(input);
        assert.equal(result.decision, 'block');
        assert(result.reason.includes('Native dispatch evidence'));
      }
    });
  });
  await test('hook ignores arbitrary transcript paths and never exposes parser text or private event data', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native, events, filename }) => {
      native([...events(['hve-squad:squad-scribe']), {
        type: 'assistant.message', data: { content: 'PRIVATE MODEL SECRET', toolCallId: 'PRIVATE-ID' } }]);
      input.transcriptPath = path.join(clone, 'SHOULD-NOT-BE-READ');
      const result = completion.evaluate(input);
      assert(result.reason.includes('next actual Plan') || result.reason.includes('next actual Research'));
      write(filename, '{"PRIVATE PARSER SECRET": ]');
      const text = JSON.stringify(completion.evaluate(input)) +
        JSON.stringify(diagnostics.report(request.subSquad, 'success', 'failure', '0'));
      for (const marker of ['PRIVATE', 'SHOULD-NOT-BE-READ', 'toolCallId', 'sessionId', request.eventId]) {
        assert(!text.includes(marker));
      }
      for (const bad of [{ ...input, cwd: directory }, { ...input, sessionId: 'wrong' },
        { ...input, stop_hook_active: undefined }, { ...input, stopReason: 'aborted' }]) {
        assert.throws(() => completion.evaluate(bad), /root stop input/);
      }
      write('.watch-run/request.json', 'CHANGED PRIVATE REQUEST');
      assert.throws(() => completion.evaluate(input), /Changed immutable request/);
    });
  });
  await test('hook bounds no-progress and total blocks within one session, never restarts a CLI', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native, events }) => {
      const names = ['hve-squad:squad-scribe'];
      native(events(names));
      for (let i = 0; i < 3; i++) assert.equal(completion.evaluate(input).decision, 'block');
      assert.deepEqual(completion.evaluate({ ...input, stop_hook_active: true }), {});
      assert.equal(progress.hookStats().status, 'no-progress');
      fs.unlinkSync(path.join(process.env.RUNNER_TEMP, 'squad-runtime', 'completion-status.json'));
      for (let i = 0; i < 8; i++) {
        names.push('hve-squad:squad-scribe');
        native(events(names));
        assert.equal(completion.evaluate(input).decision, 'block');
      }
      names.push('hve-squad:squad-scribe');
      native(events(names));
      assert.deepEqual(completion.evaluate(input), {});
      assert.equal(progress.hookStats().blocks, 8);
      assert.equal(progress.hookStats().status, 'block-limit');
    });
  });
  await test('hook entrypoint fails safely on malicious input without writes or parser messages', () => {
    const script = path.join(original, 'scripts', 'squad-watch', 'completion-gate.cjs');
    for (const input of ['{"PRIVATE": ]', 'x'.repeat(16385),
      JSON.stringify({ transcriptPath: '.git/config', sessionId: 'private' })]) {
      const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8', stdio: 'pipe' });
      assert.equal(result.status, 0);
      const value = JSON.parse(result.stdout);
      assert.equal(value.decision, 'block');
      assert(value.reason.includes('cannot-confirm'));
      assert(result.stderr.includes('no completion is established'));
      assert(!/PRIVATE|\.git\/config|Unexpected token/.test(result.stdout + result.stderr));
    }
    assert.throws(() => completion.initialize('not-a-session'));
    const previous = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = path.join(clone, 'forbidden-runtime');
    try { assert.throws(() => progress.privateRoot(), /outside checkout/); }
    finally { process.env.RUNNER_TEMP = previous; }
  });
  await test('hook command default plugin cwd cannot redirect trusted checkout or request binding', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native, events }) => {
      native(events(['hve-squad:squad-scribe']));
      const pluginCwd = path.join(directory, 'plugin-command-cwd');
      fs.mkdirSync(pluginCwd, { recursive: true });
      const result = JSON.parse(execFileSync(process.execPath,
        [path.join(original, 'scripts', 'squad-watch', 'completion-gate.cjs')], {
          cwd: pluginCwd, env: { ...process.env, HVE_WATCH_REPO_ROOT: clone },
          input: JSON.stringify(input), stdio: 'pipe'
        }).toString());
      assert.equal(result.decision, 'block');
      assert(result.reason.includes('next actual Research'));
      assert(!fs.existsSync(path.join(pluginCwd, '.copilot-tracking')));
    });
  });
  await test('hook refuses linked event parents and untrusted manifest traversal paths', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native, events, filename }) => {
      native(events(['hve-squad:squad-scribe', 'hve-squad:squad-researcher', 'hve-squad:squad-scribe']));
      const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
      const journal = JSON.parse(fs.readFileSync(root + 'pipeline.json'));
      journal.stages[0].artifact = 'research/../../.git/config';
      write(root + 'pipeline.json', JSON.stringify(journal));
      assert(completion.evaluate(input).reason.includes('actual Research role already completed'));
      const eventDirectory = path.dirname(filename);
      const target = path.join(process.env.RUNNER_TEMP, 'linked-event-target');
      fs.mkdirSync(target, { recursive: true });
      write(path.join(target, 'events.jsonl'), '{"PRIVATE LINKED TEXT": ]');
      fs.rmSync(eventDirectory, { recursive: true });
      fs.symlinkSync(target, eventDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      assert(completion.evaluate(input).reason.includes('Native dispatch evidence'));
    });
  });
  await test('complete role evidence with missing final run summary requests final Scribe, not another role', () => {
    fixtures(request);
    completionFixture(request, write, ({ input, native }) => {
      const fixture = pipelineFixture(request, write);
      native(fixture.events);
      fs.unlinkSync(fixture.root + 'history/autopilot-run-offline-fixture.md');
      const result = completion.evaluate(input);
      assert.equal(result.decision, 'block');
      assert(result.reason.includes('final readback'));
      assert(!result.reason.includes('next actual'));
    });
  });

  await test('every RPI role needs all ten consumption fields, not three empty strings', () => {
    fixtures(request);
    const { root, journal } = pipelineFixture(request, write);
    const read = filename => fs.readFileSync(root + filename, 'utf8');
    for (const entry of journal.stages) {
      const history = read(entry.history);
      const prefix = history.split('#### Consumption')[0];
      for (const field of Object.keys(consumptionFixture())) {
        const block = consumptionFixture();
        delete block[field];
        write(root + entry.history, prefix + consumptionBlock('#### Consumption', block));
        assert.throws(() => pipeline.validate(request, read), /per-stage consumption/, `${entry.stage}: ${field}`);
      }
      write(root + entry.history, prefix + consumptionBlock('#### Consumption',
        { model: '', model_source: '', basis: '' }));
      assert.throws(() => pipeline.validate(request, read), /per-stage consumption/);
      write(root + entry.history, history);
    }
  });
  await test('role and Scribe consumption numbers must be bare finite nonnegative values', () => {
    fixtures(request);
    const { root } = pipelineFixture(request, write);
    const read = filename => fs.readFileSync(root + filename, 'utf8');
    for (const [filename, heading] of [
      ['history/Squad Researcher.md', '#### Consumption'],
      ['history/Squad Scribe.md', '#### Consumption — Orchestration']
    ]) {
      const history = read(filename);
      const prefix = history.split('#### Consumption')[0];
      for (const field of ['internal_turns', 'input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens']) {
        for (const value of [null, '0', '~8,400 (estimated)', true, -1, [], {}]) {
          write(root + filename, prefix + consumptionBlock(heading, { ...consumptionFixture(), [field]: value }));
          assert.throws(() => pipeline.validate(request, read), /consumption evidence/, `${filename}: ${field}`);
        }
        write(root + filename, prefix + consumptionBlock(heading)
          .replace(`"${field}": 0`, `"${field}": 1e400`));
        assert.throws(() => pipeline.validate(request, read), /consumption evidence/);
      }
      write(root + filename, prefix + consumptionBlock(heading, { ...consumptionFixture(), internal_turns: 0.5 }));
      assert.throws(() => pipeline.validate(request, read), /consumption evidence/);
      write(root + filename, history);
    }
  });
  await test('required consumption strings are substantive and contract enums are preserved', () => {
    fixtures(request);
    const { root } = pipelineFixture(request, write);
    const read = filename => fs.readFileSync(root + filename, 'utf8');
    const filename = 'history/Squad Lead.md';
    const prefix = read(filename).split('#### Consumption')[0];
    for (const field of ['model', 'model_source', 'priced_as', 'model_tier', 'basis']) {
      for (const value of ['', ' \t ', null, 0, {}]) {
        write(root + filename, prefix + consumptionBlock('#### Consumption', { ...consumptionFixture(), [field]: value }));
        assert.throws(() => pipeline.validate(request, read), /per-stage consumption/, field);
      }
    }
    for (const [field, value] of [['model_source', 'guessed'], ['model_tier', 'standard'],
      ['basis', 'estimated, tier-default']]) {
      write(root + filename, prefix + consumptionBlock('#### Consumption', { ...consumptionFixture(), [field]: value }));
      assert.throws(() => pipeline.validate(request, read), /per-stage consumption/, field);
    }
  });
  await test('ledger-readable consumption has a closed ordered schema and one field per line', () => {
    fixtures(request);
    const { root } = pipelineFixture(request, write);
    const read = filename => fs.readFileSync(root + filename, 'utf8');
    const filename = 'history/Squad Implementor.md';
    const prefix = read(filename).split('#### Consumption')[0];
    const valid = consumptionFixture();
    const reordered = { model_source: valid.model_source, model: valid.model, ...valid };
    for (const block of [{ ...valid, turn: 1 }, { ...valid, est_cost_usd: 0 }, reordered, [], null]) {
      write(root + filename, prefix + consumptionBlock('#### Consumption', block));
      assert.throws(() => pipeline.validate(request, read), /per-stage consumption/);
    }
    for (const block of [
      consumptionBlock().replace('"model": "unknown",', '"model": "unknown",\n  "model": "unknown",'),
      consumptionBlock().replace(JSON.stringify(valid, null, 2), JSON.stringify(valid)),
      consumptionBlock().replace('"input_tokens": 0', '"input_tokens": NaN')
    ]) {
      write(root + filename, prefix + block);
      assert.throws(() => pipeline.validate(request, read), /per-stage consumption/);
    }
  });
  await test('consumption headings and JSON fences must match the exact role or orchestration container', () => {
    fixtures(request);
    const { root } = pipelineFixture(request, write);
    const read = filename => fs.readFileSync(root + filename, 'utf8');
    for (const [filename, heading, wrongRole] of [
      ['history/Squad Reviewer.md', '#### Consumption', '#### Consumption — Orchestration'],
      ['history/Squad Scribe.md', '#### Consumption — Orchestration', '#### Consumption']
    ]) {
      const history = read(filename);
      const prefix = history.split('#### Consumption')[0];
      for (const block of [
        consumptionBlock('', consumptionFixture()),
        consumptionBlock('### Consumption'),
        consumptionBlock('#### Consumption Block'),
        consumptionBlock('#### Consumption — Research'),
        consumptionBlock('#### Consumption — Orchestration (Turn 1)'),
        consumptionBlock('#### Consumption - Orchestration'),
        consumptionBlock(heading + ' suffix'),
        consumptionBlock(wrongRole),
        consumptionBlock(heading).replace('```json', '```yaml'),
        consumptionBlock(heading).replaceAll('```', '`'),
        `${heading}\n\n| Synthetic consumption | 0 |\n`,
        `${heading}\n\nUnrelated prose\n\n${consumptionBlock().split('\n\n')[1]}`
      ]) {
        write(root + filename, prefix + block);
        assert.throws(() => pipeline.validate(request, read), /consumption evidence/, filename);
      }
      write(root + filename, history);
    }
  });
  await test('unknown unresolved and observed model schemas accept LF CRLF zero and fractional tokens', () => {
    fixtures(request);
    const { root, journal } = pipelineFixture(request, write);
    const read = filename => fs.readFileSync(root + filename, 'utf8');
    assert.equal(pipeline.validate(request, read).status, 'complete');
    const block = { ...consumptionFixture(), model: cfg.model, model_source: 'session-inherited',
      priced_as: cfg.model, internal_turns: 1, input_tokens: 0.5, basis: 'estimated' };
    const entry = journal.stages[0];
    write(root + entry.history, read(entry.history).split('#### Consumption')[0] +
      consumptionBlock('#### Consumption', block));
    for (const filename of [...journal.stages.map(entry => entry.history), 'history/Squad Scribe.md']) {
      write(root + filename, read(filename).replace(/\n/g, '\r\n'));
    }
    assert.equal(pipeline.validate(request, read).status, 'complete');
  });
  await test('issue handoff rejects prose-only Scribe history and incomplete role consumption', () => {
    fixtures(request);
    const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
    write(root + 'history/Squad Scribe.md', 'Synthetic Scribe handoffs only; not an actual Squad or model run.\n');
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /Scribe orchestration consumption/);
    p.git(['read-tree', 'HEAD']);
    pipelineFixture(request, write);
    write(root + 'history/Squad Researcher.md',
      'Synthetic Research artifact research/pipeline-fixture.txt\n' +
      consumptionBlock('#### Consumption', { model: '', model_source: '', basis: '' }));
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /per-stage consumption/);
  });
  await test('readable history consumption does not impose ledger total reconciliation', () => {
    fixtures(request);
    const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
    write(root + 'consumption.md',
      '# Synthetic ledger with deliberately inconsistent totals — not billed\n\n' +
      '| Role | Est. Cost (USD) |\n|------|-----------------|\n| Research | 0.0000 |\n| Run total | 999.0000 |\n');
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    assert.equal(apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR).audit.pipeline.status, 'complete');
  });
  await test('pipeline journal alone cannot bypass missing runtime dispatch', () => {
    fixtures(request);
    fs.unlinkSync(path.join(process.env.RUNNER_TEMP, 'squad-runtime', 'dispatch.json'));
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
  });
  await test('one-role generation and missing domain artifacts no longer count as full RPI', () => {
    fixtures(request);
    const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
    fs.unlinkSync(root + 'plans/pipeline-fixture.txt');
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
    p.git(['read-tree', 'HEAD']);
    fixtures(request);
    const journal = JSON.parse(fs.readFileSync(root + 'pipeline.json'));
    journal.stages = journal.stages.slice(2, 3);
    write(root + 'pipeline.json', JSON.stringify(journal));
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /Incomplete RPI/);
  });
  await test('native observer rejects fabricated display names, failures, cancellation and overlapping Scribe', () => {
    const { journal } = pipelineFixture(request, write);
    const watcher = runtime.observer(request);
    watcher.event({ type: 'subagent.started', data: { toolCallId: '1', agentName: 'general-purpose', agentDisplayName: 'Squad Researcher' } });
    watcher.event({ type: 'subagent.completed', data: { toolCallId: '1' } });
    assert.throws(() => watcher.finish(), /absent/);
    for (const type of ['subagent.failed', 'session.error', 'abort']) {
      assert.throws(() => runtime.observer(request).event({ type }), /failed/);
    }
    const overlapping = runtime.observer(request);
    overlapping.event({ type: 'subagent.started', data: { toolCallId: '1', agentName: 'squad-scribe' } });
    assert.throws(() => overlapping.event({ type: 'subagent.started',
      data: { toolCallId: '2', agentName: 'squad-lead' } }), /Concurrent Scribe/);
    const cancelled = runtime.observer(request);
    cancelled.event({ type: 'subagent.started', data: { toolCallId: '1', agentName: 'squad-scribe' } });
    assert.throws(() => cancelled.event({ type: 'subagent.completed',
      data: { toolCallId: '1', cancelled: true } }), /cancelled/);
    const proof = runtime.readProof();
    proof.calls = proof.calls.filter(call => call.agent !== 'Squad Lead');
    assert.throws(() => pipeline.validateDispatch(proof, request, journal, '1'), /RPI role dispatch/);
  });
  await test('trusted collector persists only allowlisted lifecycle metadata, never raw prose', async () => {
    const { events } = pipelineFixture(request, write);
    events.splice(1, 0, { type: 'assistant.message', data: { content: 'PRIVATE RAW PROSE' } });
    const filename = path.join(directory, 'native-events.jsonl');
    const output = path.join(directory, 'collected.json');
    write(filename, events.map(event => JSON.stringify(event)).join('\n'));
    const proof = await runtime.collect(filename, request, output);
    assert.equal(proof.calls.length, 9);
    assert(!fs.readFileSync(output, 'utf8').includes('PRIVATE RAW PROSE'));
    assert(!fs.readFileSync(output, 'utf8').includes('toolCallId'));
  });
  await test('failed live-pattern prefix retains typed failure and later cumulative shutdown without accepting proof', async () => {
    await completionFixture(request, write, async ({ filename, native, events, input }) => {
      native([...events(['hve-squad:squad-scribe', 'hve-squad:squad-scribe']),
        { type: 'session.error', data: { errorType: 'quota', errorCode: 'session_quota_exceeded',
          statusCode: 402, message: 'PRIVATE MESSAGE', stack: 'PRIVATE STACK', url: 'PRIVATE URL',
          providerCallId: 'PRIVATE ID', providerErrorParam: 'PRIVATE PARAM' } },
        creditEvent(7e9, 'partial'), creditEvent(9e9, 'partial', 'session.shutdown')]);
      const report = diagnostics.report(request.subSquad, 'failure', 'skipped', '1');
      assert.equal(report.diagnosticContext, 'bound');
      assert.equal(report.configuredSharedSessionCapAiCredits, 90);
      assert.equal(report.cliExitCode, 1);
      assert.equal(report.exitCause, 'unknown');
      assert.equal(report.native.availability, 'invalid');
      assert.equal(report.native.completed['Squad Scribe'], 2);
      assert(pipeline.stages.every(([, agent]) => report.native.completed[agent] === 0));
      assert.equal(report.native.pending, 0);
      assert.deepEqual(report.native.errors, [{ category: 'quota',
        code: 'session_quota_exceeded', statusCode: 402, scope: 'root' }]);
      assert.deepEqual(report.native.shutdowns, [{ type: 'error', scope: 'root' }]);
      assert.equal(report.native.credits.reportedAiCredits, 9);
      assert.equal(report.native.credits.coverage, 'reported-subtotal');
      assert.equal(report.native.credits.source, 'session.shutdown');
      assert(!JSON.stringify(report).includes('PRIVATE'));
      assert.equal(completion.evaluate(input).decision, 'block');
      const output = path.join(directory, 'failed-dispatch.json');
      await assert.rejects(runtime.collect(filename, request, output), /native dispatch telemetry/);
      assert(!fs.existsSync(output));
    });
  });
  await test('complete artifacts and role dispatch never authorize handoff after a native session error', async () => {
    fixtures(request);
    await completionFixture(request, write, async ({ filename, native, input }) => {
      const { events } = pipelineFixture(request, write);
      fs.unlinkSync(path.join(process.env.RUNNER_TEMP, 'squad-runtime', 'dispatch.json'));
      native([...events, { type: 'session.error', data: { errorType: 'authentication', message: 'PRIVATE' } },
        creditEvent(90e9, 'complete')]);
      const inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.calls.length, 9);
      assert(!inspected.proof);
      assert.equal(completion.evaluate(input).decision, 'block');
      assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR));
      assert.equal(diagnostics.report(request.subSquad, 'failure', 'skipped', '1').exitCause, 'unknown');
    });
  });
  await test('only exact known categories and category-specific quota and rate codes survive projection', () => {
    completionFixture(request, write, ({ native, filename }) => {
      const codes = { quota: ['quota_exceeded', 'session_quota_exceeded', 'billing_not_configured'],
        rate_limit: ['user_weekly_rate_limited', 'user_global_rate_limited', 'rate_limited',
          'user_model_rate_limited', 'integration_rate_limited'] };
      for (const [category, values] of Object.entries(codes)) {
        for (const code of values) {
          native([{ type: 'session.error', data: { errorType: category, errorCode: code,
            statusCode: 429, message: 'PRIVATE' } }]);
          assert.deepEqual(runtime.inspectEvents(filename, request).errors,
            [{ category, code, statusCode: 429, scope: 'root' }]);
        }
      }
      for (const category of ['authentication', 'authorization', 'policy', 'context_limit', 'query']) {
        native([{ type: 'session.error', data: { errorType: category,
          errorCode: 'quota_exceeded', message: 'PRIVATE' } }]);
        assert.deepEqual(runtime.inspectEvents(filename, request).errors,
          [{ category, code: 'other', statusCode: null, scope: 'root' }]);
      }
    });
  });
  await test('unknown malicious terminal strings normalize and observations are strictly bounded', () => {
    completionFixture(request, write, ({ native, filename }) => {
      native(Array.from({ length: 100 }, (_, statusCode) => ({
        type: 'session.error', data: { errorType: 'PRIVATE\n::error::', errorCode: 'PRIVATE URL',
          message: 'PRIVATE MESSAGE', statusCode } })));
      const inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.errors.length, 16);
      assert.equal(inspected.errorsTruncated, true);
      assert(inspected.errors.every(row => row.category === 'other' && row.code === 'other'));
      assert(!JSON.stringify(inspected).includes('PRIVATE'));
      for (const statusCode of [-1, 1000, 401.5, '401', null]) {
        native([{ type: 'session.error', data: { errorType: {}, errorCode: {}, statusCode } }]);
        assert.equal(runtime.inspectEvents(filename, request).errors[0].statusCode, null);
      }
    });
  });
  await test('abort and shutdown enums keep objective-cap scope distinct from shared-session limits', () => {
    completionFixture(request, write, ({ native, filename, events }) => {
      for (const reason of ['user_initiated', 'remote_command', 'user_abort', 'autopilot_credit_limit', 'PRIVATE']) {
        native([...events(['hve-squad:squad-scribe']), { type: 'abort', data: { reason } },
          creditEvent(1e9, 'complete')]);
        const inspected = runtime.inspectEvents(filename, request);
        assert.equal(inspected.availability, 'invalid');
        assert.deepEqual(inspected.aborts, [{ reason: reason === 'PRIVATE' ? 'other' : reason, scope: 'root' }]);
        assert.equal(inspected.credits.reportedAiCredits, 1);
        assert.equal(inspected.sessionLimit.observed, false);
      }
      for (const shutdownType of ['routine', 'error', 'PRIVATE']) {
        native([...events(['hve-squad:squad-scribe']),
          { type: 'session.shutdown', data: { shutdownType, errorReason: 'PRIVATE REASON' } }]);
        const inspected = runtime.inspectEvents(filename, request);
        assert.equal(inspected.availability, shutdownType === 'error' ? 'invalid' : 'valid');
        assert.equal(inspected.shutdowns[0].type, shutdownType === 'PRIVATE' ? 'other' : shutdownType);
        assert.equal(inspected.credits.reportedAiCredits, null);
        assert(!JSON.stringify(inspected).includes('PRIVATE'));
      }
      native([{ type: 'session_limits_exhausted.requested',
        data: { maxAiCredits: 90, usedAiCredits: 91, requestId: 'PRIVATE' } }]);
      assert.deepEqual(runtime.inspectEvents(filename, request).sessionLimit,
        { observed: true, maxAiCredits: 90, usedAiCredits: 91 });
      native([{ type: 'session_limits_exhausted.requested', data: { maxAiCredits: '90', usedAiCredits: -1 } }]);
      assert.equal(runtime.inspectEvents(filename, request).sessionLimit.observed, false);
    });
  });
  await test('repeated snapshots are not receipts and regressing snapshots cannot replace the retained cumulative value', () => {
    completionFixture(request, write, ({ native, filename, events }) => {
      native([creditEvent(3e9, 'complete'), creditEvent(3e9, 'complete'),
        { type: 'assistant.usage', data: { copilotUsage: { totalNanoAiu: 100e9 } } },
        { type: 'session.usage_info', data: { currentTokens: 999999 } },
        { ...creditEvent(4e9, 'complete', 'session.shutdown'),
          data: { ...creditEvent(4e9, 'complete', 'session.shutdown').data,
            shutdownType: 'routine', modelMetrics: { PRIVATE: { totalNanoAiu: 50e9 } },
            agentMetrics: { PRIVATE: { totalNanoAiu: 50e9 } } } }]);
      let inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.credits.reportedAiCredits, 4);
      assert.equal(inspected.credits.source, 'session.shutdown');
      assert.equal(inspected.credits.coverage, 'reported-complete');
      assert(!JSON.stringify(inspected).includes('PRIVATE'));
      native([...events(['hve-squad:squad-scribe']),
        creditEvent(4e9, 'complete'), creditEvent(2e9, 'complete'), creditEvent(4e9, 'complete')]);
      inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.credits.reportedAiCredits, 4);
      assert.equal(inspected.credits.regressed, true);
      assert.equal(inspected.credits.coverage, 'unavailable');
      assert.equal(inspected.availability, 'valid');
      assert(inspected.proof);
    });
  });
  await test('child accounting never adds to or replaces the root reported subtotal', () => {
    completionFixture(request, write, ({ native, filename }) => {
      native([creditEvent(2e9, 'partial'), { ...creditEvent(100e9, 'complete'), agentId: 'PRIVATE' }]);
      let inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.credits.reportedAiCredits, 2);
      assert.equal(inspected.credits.ignoredChildSnapshots, 1);
      assert.equal(inspected.credits.coverage, 'reported-subtotal');
      native([{ ...creditEvent(100e9, 'complete'), agentId: 'PRIVATE' }]);
      inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.credits.reportedAiCredits, null);
      assert.equal(inspected.credits.coverage, 'unavailable');
      native([{ ...creditEvent(100e9, 'complete'), agentId: null }]);
      assert.equal(runtime.inspectEvents(filename, request).availability, 'incomplete');
    });
  });
  await test('explicit zero requires status coverage; missing durable status is unknown, not free usage', () => {
    completionFixture(request, write, ({ native, filename }) => {
      for (const [status, coverage] of [[undefined, 'unavailable'], ['unavailable', 'unavailable'],
        ['partial', 'reported-subtotal'], ['complete', 'reported-complete']]) {
        native([creditEvent(0, status)]);
        const inspected = runtime.inspectEvents(filename, request);
        assert.equal(inspected.credits.reportedAiCredits, 0);
        assert.equal(inspected.credits.coverage, coverage);
      }
      native([{ type: 'session.usage_checkpoint', data: { totalNanoAiu: 0, aiCreditsStatus: 'complete' } }]);
      assert.equal(runtime.inspectEvents(filename, request).credits.coverage, 'unavailable');
      native([{ type: 'session.shutdown', data: { shutdownType: 'error' } }]);
      assert.equal(runtime.inspectEvents(filename, request).credits.reportedNanoAiu, null);
    });
  });
  await test('accounting warnings retain proof while broken lifecycle remains invalid', () => {
    completionFixture(request, write, ({ native, filename, events }) => {
      for (const bad of [null, -1, '1', Number.MAX_VALUE, {}, undefined]) {
        native([...events(['hve-squad:squad-scribe']), creditEvent(bad),
          creditEvent(5e9, 'complete')]);
        const inspected = runtime.inspectEvents(filename, request);
        assert.equal(inspected.availability, 'valid');
        assert(inspected.proof);
        assert.equal(inspected.credits.reportedAiCredits, 5);
        assert.equal(inspected.credits.coverage, 'unavailable');
        assert.equal(inspected.credits.malformedSnapshots, 1);
      }
      for (const accountingSnapshot of [{ totalNanoAiu: 99 }, { aiCreditsStatus: 'PRIVATE' }, []]) {
        native([{ type: 'session.usage_checkpoint', data: { totalNanoAiu: 1, accountingSnapshot } }]);
        assert.equal(runtime.inspectEvents(filename, request).credits.reportedNanoAiu, null);
      }
      for (const bad of [{ type: 'subagent.completed', data: { toolCallId: 'PRIVATE' } },
        { type: 'subagent.failed' }, null, { type: 'subagent.started', data: {} }]) {
        native([...events(['hve-squad:squad-scribe']), bad, creditEvent(5e9, 'complete')]);
        const inspected = runtime.inspectEvents(filename, request);
        assert.equal(inspected.availability, 'invalid');
        assert.equal(inspected.calls.length, 1);
        assert.equal(inspected.credits.reportedAiCredits, 5);
        assert(!JSON.stringify(inspected).includes('PRIVATE'));
      }
      native([...events(['hve-squad:squad-scribe']),
        { type: 'subagent.started', data: { toolCallId: 'cancel', agentName: 'squad-lead' } },
        { type: 'subagent.completed', data: { toolCallId: 'cancel', cancelled: true } },
        creditEvent(5e9, 'complete')]);
      assert.equal(runtime.inspectEvents(filename, request).availability, 'invalid');
      write(filename, '{"PRIVATE PARSER": ]\n' + JSON.stringify(creditEvent(5e9, 'complete')));
      const inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.credits.reportedAiCredits, 5);
      assert.equal(inspected.credits.coverage, 'unavailable');
      assert(inspected.failures.includes('malformed-event'));
    });
  });
  await test('accounting discrepancies cannot block complete RPI history, hook or handoff', async () => {
    fixtures(request);
    await completionFixture(request, write, async ({ native, filename, input }) => {
      const fixture = pipelineFixture(request, write);
      native([...fixture.events, creditEvent(4e9, 'complete'), creditEvent(2e9, 'complete'),
        creditEvent('PRIVATE INVALID AMOUNT')]);
      const inspected = runtime.inspectEvents(filename, request);
      assert.equal(inspected.availability, 'valid');
      assert.equal(inspected.credits.coverage, 'unavailable');
      assert(inspected.credits.regressed);
      assert.deepEqual(completion.evaluate(input), {});
      const proofPath = path.join(process.env.RUNNER_TEMP, 'squad-runtime', 'dispatch.json');
      fs.unlinkSync(proofPath);
      await runtime.collect(filename, request, proofPath);
      handoff.stage(request, cfg, process.env.HANDOFF_DIR);
      assert(!JSON.stringify(diagnostics.report(request.subSquad, 'success', 'success', '0')).includes('PRIVATE'));
    });
  });
  await test('diagnostic context and immutable cap binding fail safely without arbitrary request data', () => {
    completionFixture(request, write, ({ native }) => {
      native([creditEvent(109e9, 'complete'), {
        type: 'session_limits_exhausted.requested', data: { maxAiCredits: 999, usedAiCredits: 1001 }
      }]);
      const bounded = progress.diagnostics(request.subSquad);
      assert.equal(bounded.configuredSharedSessionCapAiCredits, 90);
      assert.equal(bounded.configuredCreditMode, 'bounded');
      assert.equal(bounded.native.credits.reportedAiCredits, 109);
      assert.equal(bounded.native.sessionLimit.maxAiCredits, 999);
      assert.equal(progress.diagnostics('issue-99').diagnosticContext, 'unavailable');
      write('.watch-run/request.json', 'PRIVATE CHANGED REQUEST');
      const report = progress.diagnostics(request.subSquad);
      assert.equal(report.diagnosticContext, 'unavailable');
      assert.equal(report.native.availability, 'unavailable');
      assert.equal(report.native.credits.reportedAiCredits, null);
      assert.equal(report.configuredSharedSessionCapAiCredits, null);
      assert.equal(report.configuredCreditMode, 'unavailable');
      assert(report.configuredCreditPolicy.includes('mode is unknown'));
      assert(!JSON.stringify(report).includes('PRIVATE'));
    });
  });
  await test('failure diagnostic entrypoint publishes only bounded facts to JSON and summary, never native text', () => {
    completionFixture(request, write, ({ native, events }) => {
      native([...events(['hve-squad:squad-scribe']),
        { type: 'session.error', data: { errorType: 'authentication', message: 'PRIVATE MESSAGE',
          errorCode: 'PRIVATE CODE', url: 'PRIVATE URL', stack: 'PRIVATE STACK', serviceRequestId: 'PRIVATE ID' } },
        creditEvent(5e9, 'partial', 'session.shutdown')]);
      const destination = path.join(clone, '.watch-run', 'failure-diagnostic');
      const summary = path.join(clone, '.watch-run', 'failure-summary');
      const result = spawnSync(process.execPath, [path.join(original, 'scripts', 'squad-watch', 'diagnostics.cjs')], {
        env: { ...process.env, AUDIT_MEMBER: request.subSquad, MODEL_OUTCOME: 'failure',
          HANDOFF_OUTCOME: 'skipped', CLI_EXIT_CODE: '1', DIAGNOSTIC_DIR: destination,
          GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8'
      });
      assert.equal(result.status, 0);
      const bytes = fs.readFileSync(path.join(destination, 'runtime-status.json'), 'utf8');
      assert(!/PRIVATE|toolCallId|sessionId/.test(bytes + result.stdout + result.stderr +
        fs.readFileSync(summary, 'utf8')));
      assert.equal(JSON.parse(bytes).native.credits.reportedAiCredits, 5);
      assert.deepEqual(fs.readdirSync(destination), ['runtime-status.json']);
    });
  });
  await test('independent apply rejects stage evidence without the actual ordered runtime proof', () => {
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    const filename = path.join(process.env.HANDOFF_DIR, 'handoff.json');
    const manifest = JSON.parse(fs.readFileSync(filename));
    delete manifest.dispatch;
    write(filename, JSON.stringify(manifest));
    assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR), /runtime dispatch/);
  });
  await test('real blocked prefix is explicit and cannot authorize premature source implementation', () => {
    fixtures(request);
    const { journal, root } = pipelineFixture(request, write);
    journal.status = 'blocked';
    journal.blockingReason = 'Synthetic Risk Stop; implementation must not run';
    journal.stages = journal.stages.slice(0, 1);
    write(root + 'pipeline.json', JSON.stringify(journal));
    const proof = runtime.readProof();
    proof.calls = proof.calls.slice(0, 3);
    write(path.join(process.env.RUNNER_TEMP, 'squad-runtime', 'dispatch.json'), JSON.stringify(proof));
    assert.throws(() => handoff.stage(request, cfg, process.env.HANDOFF_DIR), /completed Implement/);
    p.git(['read-tree', 'HEAD']);
    fs.unlinkSync('GrubifyApi/watch-contract-fixture.txt');
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    clean();
    assert.equal(apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR).audit.pipeline.status, 'blocked');
  });
  await test('runtime assembly validates required roles and adapts only ephemeral identities/models/skills', () => {
    const input = path.join(directory, 'bootstrap-input');
    fs.mkdirSync(input, { recursive: true });
    process.chdir(input);
    try {
      const roles = [['Squad Scribe', 'squad-scribe'], ['RPI Researcher', 'rpi-researcher'],
        ...pipeline.stages.map(row => [row[1], row[2]])];
      for (const [name, id] of roles) {
        write(`.github/agents/${id}.agent.md`, `---\nname: ${name}\nmodel: Claude Sonnet 5 (copilot)\nagents:\n  - RPI Researcher\n  - Missing Optional Role\n---\nFixture\n`);
      }
      write('.github/agents/optional.agent.md', '---\ndescription: Nameless optional fixture\nagents:\n  - Missing Optional Role\n---\nFixture\n');
      for (const skill of ['squad', 'rpi-research', 'rpi-plan', 'rpi-implement', 'rpi-review', 'code-review']) {
        write(`.agents/skills/${skill}/SKILL.md`, 'Synthetic skill fixture\n');
      }
      write('scripts/squad-watch/runtime-plugin.json',
        fs.readFileSync(path.join(original, 'scripts', 'squad-watch', 'runtime-plugin.json')));
      for (const file of ['policy.cjs', 'pipeline.cjs', 'runtime.cjs', 'progress.cjs',
        'completion-gate.cjs', 'runtime-hooks.json']) {
        write('scripts/squad-watch/' + file, fs.readFileSync(path.join(original, 'scripts', 'squad-watch', file)));
      }
      const source = fs.readFileSync('.github/agents/squad-researcher.agent.md');
      runtime.assemble('runtime');
      const adapted = fs.readFileSync('runtime/agents/squad/squad-researcher.agent.md', 'utf8');
      assert(adapted.includes('model: claude-sonnet-5'));
      assert(adapted.includes('  - hve-squad:rpi-researcher'));
      assert(!adapted.includes('Missing Optional Role'));
      assert(fs.readFileSync('runtime/agents/squad/optional.agent.md', 'utf8').includes('agents: []'));
      assert(fs.readFileSync('.github/agents/squad-researcher.agent.md').equals(source));
      const manifest = JSON.parse(fs.readFileSync('runtime/plugin.json'));
      assert(manifest.skills.includes('skills/rpi-research/'));
      assert.equal(manifest.$schema, undefined, 'Use verified legacy component paths, not Agent Plugins mixing');
      assert.equal(manifest.hooks, 'hooks/hooks.json');
      const hooks = JSON.parse(fs.readFileSync('runtime/hooks/hooks.json'));
      assert.equal(hooks.version, 1);
      assert.deepEqual(Object.keys(hooks.hooks), ['agentStop']);
      assert.equal(hooks.hooks.agentStop[0].env.HVE_SQUAD_PLUGIN_ROOT, '${PLUGIN_ROOT}');
      assert.equal(hooks.hooks.agentStop[0].timeoutSec, 10);
      assert(fs.readFileSync('runtime/scripts/completion-gate.cjs').equals(
        fs.readFileSync(path.join(original, 'scripts/squad-watch/completion-gate.cjs'))));
      fs.unlinkSync('.github/agents/squad-implementor.agent.md');
      assert.throws(() => runtime.assemble('missing-role-runtime'), /not deployed/);
    } finally { process.chdir(clone); }
  });

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
    assert.deepEqual(p.creditBudget('unset', cfg, true), { maxAiCredits: null, uncappedDiagnostic: true });
    for (const value of [null, 'null', '0', '-1', 'Unset', ' unset', 'unset ', 'undefined', '9000']) {
      assert.throws(() => p.creditBudget(value, cfg, true));
    }
    for (const budget of [{ maxAiCredits: null }, { maxAiCredits: null, uncappedDiagnostic: false },
      { maxAiCredits: 90, uncappedDiagnostic: true }, { maxAiCredits: '90', uncappedDiagnostic: false },
      { uncappedDiagnostic: true }, { maxAiCredits: null, uncappedDiagnostic: 'true' }]) {
      assert.throws(() => p.creditInput(budget, cfg));
    }
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
    assert(value.includes('| Sub-squad | Profile | Kind | Location | Owner | Description |'));
    assert(value.includes(`| watch: ${request.ref} | ${request.subSquad} | no |`));
    assert(value.includes(`trigger.eventId="${request.eventId}"`));
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
    assert.equal(snapshot.uncappedDiagnostic, false);
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
    assert.equal(snapshot.uncappedDiagnostic, false);
    assert.equal(snapshot.eventId, 'issues:142');
    requestEnvironment(snapshot);
    await prepare.revalidate(api);
    requestEnvironment(request);
  });
  await test('authorized manual unset survives immutable request, handoff, apply and deterministic review linkage', async () => {
    const api = mock(request, { issue: { labels: [] } });
    api.context.eventName = 'workflow_dispatch';
    api.context.payload.inputs = { issue_number: '42', max_ai_credits: 'unset' };
    await prepare(api);
    const diagnostic = JSON.parse(p.requestBytes());
    assert.equal(diagnostic.maxAiCredits, null);
    assert.equal(diagnostic.uncappedDiagnostic, true);
    assert.equal(api.outputs.request_sha256, p.digest(p.requestBytes()));
    requestEnvironment(diagnostic);
    await prepare.revalidate(api);
    const prompt = handoff.prompt(diagnostic);
    assert(prompt.includes('Uncapped diagnostic: no native AI-credit ceiling; 30-minute timeout still applies'));
    assert(prompt.includes('A Risk Stop verdict stops Implement'));
    assert(!/null AI credits|90 AI credits/.test(prompt));
    fixtures(diagnostic);
    completionFixture(diagnostic, write, ({ native }) => {
      native([creditEvent(108929595000, 'partial')]);
      const report = diagnostics.report(diagnostic.subSquad, 'failure', 'skipped', '1');
      assert.equal(report.configuredCreditMode, 'uncapped-diagnostic');
      assert.equal(report.configuredSharedSessionCapAiCredits, null);
      assert(report.configuredCreditPolicy.includes('30-minute timeout'));
      assert.equal(report.native.credits.reportedAiCredits, 108.929595);
      assert.equal(report.native.credits.coverage, 'reported-subtotal');
    });
    handoff.stage(diagnostic, cfg, process.env.HANDOFF_DIR);
    const manifest = JSON.parse(fs.readFileSync(path.join(process.env.HANDOFF_DIR, 'handoff.json')));
    assert.equal(manifest.maxAiCredits, null);
    assert.equal(manifest.uncappedDiagnostic, true);
    clean();
    await apply(api);
    const linkage = JSON.parse(fs.readFileSync(path.join(process.env.RESULT_DIR, 'result.json')));
    assert.equal(linkage.generationSource, 'workflow_dispatch');
    assert.equal(linkage.generationMaxAiCreditsInput, 'unset');
    assert.equal(linkage.maxAiCredits, null);
    assert.equal(linkage.uncappedDiagnostic, true);
    assert.equal(api.outputs.review_max_ai_credits, 'unset');
    const body = api.writes.find(([kind]) => kind === 'pr')[1].body;
    assert(body.includes('second independent session inherits'));
    assert(body.includes('Uncapped diagnostic: no native AI-credit ceiling; 30-minute timeout still applies'));
    assert(!/null AI credits|own 90-credit/.test(body));
    requestEnvironment(request);
  });
  await test('uncapped opt-in is per manual dispatch, never label inputs or issue prose', async () => {
    const api = mock(request, { issue: { body: 'max_ai_credits=unset uncappedDiagnostic=true' } });
    api.context.payload.inputs = { max_ai_credits: 'unset' };
    await prepare(api);
    const bounded = JSON.parse(p.requestBytes());
    assert.equal(bounded.maxAiCredits, 90);
    assert.equal(bounded.uncappedDiagnostic, false);
    requestEnvironment(bounded);
    await prepare.revalidate(api);
    api.context.eventName = 'workflow_dispatch';
    api.context.payload.inputs = { issue_number: '42' };
    await prepare(api);
    assert.equal(JSON.parse(p.requestBytes()).maxAiCredits, 90);
    assert.equal(JSON.parse(p.requestBytes()).uncappedDiagnostic, false);
    requestEnvironment(request);
  });
  await test('manual unset still requires initial and current collaborator authorization', async () => {
    for (const actor of ['Peter-N91', 'reader']) {
      const api = mock(request, { permissions: { [actor]: 'read' } });
      api.context.eventName = 'workflow_dispatch';
      api.context.payload.inputs = { issue_number: '42', max_ai_credits: 'unset' };
      process.env.TRIGGERING_ACTOR = actor;
      await prepare(api);
      assert.equal(api.outputs.authorized, 'false');
      assert.equal(api.writes.length, 0);
    }
    process.env.TRIGGERING_ACTOR = 'Peter-N91';
  });
  await test('immutable forged null/missing/mismatched credit modes fail before model and apply', async () => {
    for (const budget of [{ maxAiCredits: null, uncappedDiagnostic: true },
      { maxAiCredits: null, uncappedDiagnostic: false }, { maxAiCredits: null, uncappedDiagnostic: undefined },
      { maxAiCredits: 90, uncappedDiagnostic: undefined }, { maxAiCredits: 60, uncappedDiagnostic: false }]) {
      const forged = { ...request, ...budget };
      requestEnvironment(forged);
      const api = mock(forged);
      await assert.rejects(prepare.revalidate(api));
      await assert.rejects(apply(api));
      assert.equal(api.writes.length, 0);
    }
    for (const input of ['', undefined, '90', '60']) {
      const forged = { ...request, source: 'workflow_dispatch', maxAiCredits: null, uncappedDiagnostic: true };
      requestEnvironment(forged);
      const api = mock(forged);
      api.context.eventName = 'workflow_dispatch';
      api.context.payload.inputs = { issue_number: '42', max_ai_credits: input };
      await assert.rejects(prepare.revalidate(api), /credit mode\/cap/);
      await assert.rejects(apply(api), /credit mode\/cap/);
    }
    requestEnvironment(request);
  });
  await test('uncapped handoff mode cannot be removed or changed independently of immutable request', () => {
    fixtures(request);
    handoff.stage(request, cfg, process.env.HANDOFF_DIR);
    const filename = path.join(process.env.HANDOFF_DIR, 'handoff.json');
    const manifest = JSON.parse(fs.readFileSync(filename));
    clean();
    for (const budget of [{ maxAiCredits: null, uncappedDiagnostic: true },
      { maxAiCredits: 60, uncappedDiagnostic: false }, { uncappedDiagnostic: undefined }]) {
      write(filename, JSON.stringify({ ...manifest, ...budget }));
      assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR));
    }
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
    const safeError = diagnostics.stageError(new Error('secret'));
    assert(!safeError.includes('secret'));
    assert(safeError.includes(p.digest('secret').slice(0, 12)));
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
    assert(fs.readFileSync(summary, 'utf8').includes('upstream quota scope is unknown'));
  });
  await test('both CLI launchers pin and trust the checked-out repository root', () => {
    for (const script of ['run-squad.sh', 'run-review.sh']) {
      const launcher = fs.readFileSync(path.join(original, 'scripts', 'squad-watch', script), 'utf8');
      assert(launcher.includes('readonly REPO_ROOT="$PWD"'));
      assert(launcher.includes('export HVE_WATCH_REPO_ROOT="$REPO_ROOT"'));
      assert(launcher.includes('-C "$REPO_ROOT"'));
      assert(launcher.includes('--add-dir "$REPO_ROOT"'));
      assert(launcher.includes('--plugin-dir "$RUNTIME_PLUGIN"'));
      assert(launcher.includes('--agent hve-squad:squad-federation-coordinator'));
      assert(launcher.includes('completion-gate.cjs" init "$SESSION_ID"'));
      assert(launcher.includes('30m'));
      assert(launcher.includes('--max-ai-credits "$CREDITS"'));
      assert(launcher.includes('"${CREDIT_ARGS[@]}"'));
      assert.equal((launcher.match(/^\s+copilot --no-auto-update/gm) || []).length, 1);
    }
  });
  if (process.platform !== 'win32') {
    const launches = ['run-squad.sh', 'run-review.sh'].flatMap(script =>
      ['90', '60', 'unset'].map(input => [script, input]));
    for (const [script, creditInput] of launches) {
      await test(`${script} real Bash argv ${creditInput} preserves timeout/exit/private boundary (mock CLI, no AI)`, () => {
        const launchRequest = { ...request, source: script === 'run-review.sh' ? 'pr' : 'workflow_dispatch',
          ...p.creditBudget(creditInput, cfg, true) };
        const bin = path.join(clone, '.watch-run', 'mock-bin');
        const output = path.join(clone, '.watch-run', 'outputs');
        const argsFile = path.join(clone, '.watch-run', 'copilot-args');
        const timeoutArgs = path.join(clone, '.watch-run', 'timeout-args');
        const runnerTemp = path.join(directory, script + '-runner-temp');
        const plugin = path.join(runnerTemp, 'squad-tools', 'hve-squad-runtime');
        const helper = path.join(runnerTemp, 'squad-runtime', 'helper');
        write(path.join(plugin, 'plugin.json'), '{}');
        for (const name of ['runtime', 'pipeline', 'policy', 'progress', 'completion-gate']) {
          write(path.join(helper, name + '.cjs'),
            fs.readFileSync(path.join(original, 'scripts', 'squad-watch', name + '.cjs')));
        }
        const nativeEvents = path.join(clone, '.watch-run', 'native-events.jsonl');
        const { events } = pipelineFixture(launchRequest, write);
        write(nativeEvents, events.map(event => JSON.stringify(event)).join('\n'));
        const requestBytes = JSON.stringify(launchRequest);
        write('.watch-run/request.json', requestBytes);
        write('.watch-run/prompt.txt', 'Offline fixture, never a real model request\n');
        const wrapper = path.join(clone, '.watch-run', 'runtime-fixture.sh');
        write(wrapper, fs.readFileSync(path.join(original, 'scripts', 'squad-watch', script), 'utf8')
          .replace(/\r\n/g, '\n'));
        write(path.join(bin, 'copilot'), '#!/bin/bash\nprintf \"%s\\\\n\" \"$@\" > \"$FIXTURE_ARGS\"\n' +
          'while (( $# )); do if [[ "$1" == "--session-id" ]]; then session="$2"; shift; fi; shift; done\n' +
          'mkdir -p "$COPILOT_HOME/session-state/$session"\n' +
          'cp "$FIXTURE_NATIVE_EVENTS" "$COPILOT_HOME/session-state/$session/events.jsonl"\n' +
          'printf \"private fixture text must not escape\\\\n\" >&2\nexit \"$FIXTURE_EXIT\"\n');
        fs.chmodSync(path.join(bin, 'copilot'), 0o755);
        write(path.join(bin, 'timeout'), '#!/bin/bash\nprintf \"%s\\\\n\" \"$@\" > \"$FIXTURE_TIMEOUT_ARGS\"\nexec /usr/bin/timeout \"$@\"\n');
        fs.chmodSync(path.join(bin, 'timeout'), 0o755);
        for (const code of [0, 1, 7, 124]) {
          fs.rmSync(path.join(runnerTemp, 'squad-runtime', 'copilot-home'), { recursive: true, force: true });
          fs.rmSync(path.join(runnerTemp, 'squad-runtime', 'dispatch.json'), { force: true });
          fs.rmSync(path.join(runnerTemp, 'squad-runtime', 'completion-context.json'), { force: true });
          write(output, '');
          write(argsFile, '');
          write(nativeEvents, [...events, ...(code === 1 ? [
            { type: 'session.error', data: { errorType: 'quota',
              errorCode: 'session_quota_exceeded', message: 'private fixture error' } },
            creditEvent(4e9, 'partial'), creditEvent(5e9, 'partial', 'session.shutdown')
          ] : [])].map(event => JSON.stringify(event)).join('\n'));
          let stdout;
          try {
            stdout = execFileSync('bash', [wrapper], {
              env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
                HOME: path.join(clone, '.watch-run'), COPILOT_GITHUB_TOKEN: 'offline-dummy-not-a-credential',
                GITHUB_OUTPUT: output, RUNNER_TEMP: runnerTemp,
                GITHUB_RUN_ATTEMPT: '1', EXPECTED_REQUEST_SHA256: p.digest(requestBytes),
                FIXTURE_TIMEOUT_ARGS: timeoutArgs,
                FIXTURE_NATIVE_EVENTS: nativeEvents,
                FIXTURE_ARGS: argsFile, FIXTURE_EXIT: String(code) }, stdio: 'pipe'
            }).toString();
            assert.equal(code, 0);
          } catch (error) {
            assert.equal(error.status, code);
            stdout = error.stdout.toString() + error.stderr.toString();
          }
          assert(!stdout.includes('private fixture text'));
          assert.equal(fs.existsSync(path.join(runnerTemp, 'squad-runtime', 'dispatch.json')), code === 0);
          assert.equal(fs.readFileSync(output, 'utf8'), `cli_exit_code=${code}\n`);
          const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
          assert.equal(args[args.indexOf('-C') + 1], clone);
          assert.equal(args[args.indexOf('--add-dir') + 1], clone);
          assert.equal(args[args.indexOf('--plugin-dir') + 1], plugin);
          assert(args.includes('hve-squad:squad-federation-coordinator'));
          if (creditInput === 'unset') {
            assert(!args.includes('--max-ai-credits'));
            assert(!args.some(arg => ['unset', 'null', '0'].includes(arg)));
          } else {
            assert.equal(args.filter(arg => arg === '--max-ai-credits').length, 1);
            assert.equal(args[args.indexOf('--max-ai-credits') + 1], creditInput);
          }
          assert.deepEqual(fs.readFileSync(timeoutArgs, 'utf8').split('\n').slice(0, 4),
            ['--signal=TERM', '--kill-after=30s', '30m', 'copilot']);
          if (code === 1) {
            const diagnosticDir = path.join(clone, '.watch-run', 'launcher-diagnostic');
            const diagnostic = spawnSync(process.execPath,
              [path.join(original, 'scripts', 'squad-watch', 'diagnostics.cjs')], {
                env: { ...process.env, RUNNER_TEMP: runnerTemp, DIAGNOSTIC_DIR: diagnosticDir,
                  EXPECTED_REQUEST_SHA256: p.digest(requestBytes),
                  AUDIT_MEMBER: request.subSquad, MODEL_OUTCOME: 'failure',
                  HANDOFF_OUTCOME: 'skipped', CLI_EXIT_CODE: '1' }, encoding: 'utf8'
              });
            assert.equal(diagnostic.status, 0);
            const bytes = fs.readFileSync(path.join(diagnosticDir, 'runtime-status.json'), 'utf8');
            const report = JSON.parse(bytes);
            assert.equal(report.diagnosticContext, 'bound');
            assert.equal(report.configuredCreditMode, creditInput === 'unset' ? 'uncapped-diagnostic' : 'bounded');
            assert.equal(report.native.availability, 'invalid');
            assert.equal(report.native.credits.reportedAiCredits, 5);
            assert.equal(report.native.errors[0].code, 'session_quota_exceeded');
            assert(!/private fixture/.test(bytes + diagnostic.stdout + diagnostic.stderr + stdout));
          }
        }
      });
    }
    for (const script of ['run-squad.sh', 'run-review.sh']) {
      await test(`${script} real Bash rejects malformed credit modes before CLI invocation`, () => {
        const runnerTemp = path.join(directory, script + '-invalid-runner');
        const helper = path.join(runnerTemp, 'squad-runtime', 'helper');
        write(path.join(helper, 'policy.cjs'),
          fs.readFileSync(path.join(original, 'scripts', 'squad-watch', 'policy.cjs')));
        const bin = path.join(clone, '.watch-run', 'invalid-bin');
        const called = path.join(clone, '.watch-run', 'invalid-cli-called');
        write(path.join(bin, 'copilot'), '#!/bin/bash\nprintf called > \"$FIXTURE_CALLED\"\nexit 99\n');
        fs.chmodSync(path.join(bin, 'copilot'), 0o755);
        const wrapper = path.join(clone, '.watch-run', 'invalid-launcher.sh');
        write(wrapper, fs.readFileSync(path.join(original, 'scripts', 'squad-watch', script), 'utf8')
          .replace(/\r\n/g, '\n'));
        for (const budget of [{ maxAiCredits: null, uncappedDiagnostic: false },
          { maxAiCredits: null, uncappedDiagnostic: undefined },
          { maxAiCredits: 90, uncappedDiagnostic: true }, { maxAiCredits: 9000, uncappedDiagnostic: false },
          { maxAiCredits: 'null', uncappedDiagnostic: true },
          { maxAiCredits: null, uncappedDiagnostic: true, source: 'issue' }]) {
          write('.watch-run/request.json', JSON.stringify({ ...request, source: 'workflow_dispatch', ...budget }));
          const result = spawnSync('bash', [wrapper], {
            env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
              COPILOT_GITHUB_TOKEN: 'offline-dummy-not-a-credential', RUNNER_TEMP: runnerTemp,
              FIXTURE_CALLED: called }, encoding: 'utf8'
          });
          assert.equal(result.status, 1);
          assert.equal(fs.existsSync(called), false);
          assert.equal(fs.existsSync(path.join(runnerTemp, 'squad-runtime', 'copilot-home')), false);
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
      maxAiCredits: request.maxAiCredits, uncappedDiagnostic: request.uncappedDiagnostic,
      issue: request.issue, subSquad: request.subSquad, patchSha256: p.digest(''), files: []
    }));
    assert.throws(() => apply.validateArtifact(request, cfg, process.env.HANDOFF_DIR),
      error => error.code === 'SQUAD_AUDIT_INCOMPLETE');
  });

  const workflow = fs.readFileSync(path.join(original, '.github/workflows/squad-watch.yml'), 'utf8');
  assert(workflow.includes("vars.SQUAD_WATCH_ENABLED == 'true'"));
  assert(workflow.includes('blank=90'));
  assert(workflow.includes('Exact unset removes native ceiling for generation AND review'));
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
