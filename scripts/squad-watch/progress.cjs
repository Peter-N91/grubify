'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('./policy.cjs');
const pipeline = require('./pipeline.cjs');
const runtime = require('./runtime.cjs');

function read(filename, maximum = 1048576) {
  const file = runtime.regularPath(filename, maximum);
  p.check(file, 'Required progress file missing');
  return p.text(fs.readFileSync(file));
}

function presence(filename) {
  try { return runtime.regularPath(filename, 1048576) ? 'regular' : 'absent'; }
  catch { return 'unsafe-or-unreadable'; }
}

function privateRoot() {
  p.check(path.isAbsolute(process.env.RUNNER_TEMP || ''), 'Missing private runtime directory');
  const root = path.join(process.env.RUNNER_TEMP, 'squad-runtime');
  const relative = path.relative(process.cwd(), root);
  p.check(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'Runtime telemetry must be outside checkout');
  return root;
}

function context() {
  const root = privateRoot();
  const value = JSON.parse(read(path.join(root, 'completion-context.json'), 4096));
  p.check(value.schemaVersion === 1 && value.repoRoot === process.cwd() &&
    /^[0-9a-f-]{36}$/.test(value.sessionId) && /^[0-9a-f]{64}$/.test(value.requestSha256) &&
    value.requestSha256 === process.env.EXPECTED_REQUEST_SHA256 &&
    value.runAttempt === process.env.GITHUB_RUN_ATTEMPT &&
    value.home === path.join(root, 'copilot-home'), 'Unbound completion context');
  const bytes = read('.watch-run/request.json', 150000);
  p.check(p.digest(bytes) === value.requestSha256, 'Changed immutable request');
  const request = JSON.parse(bytes);
  p.auditTargets(request.subSquad);
  p.check(['issue', 'workflow_dispatch', 'pr'].includes(request.source) &&
    typeof request.runId === 'string' && /^[1-9][0-9]*$/.test(request.runId),
  'Unsupported completion request');
  return { ...value, request };
}

function inspect(sub, bound) {
  p.auditTargets(sub);
  const root = `.copilot-tracking/squad/members/${sub}/`;
  const histories = Object.fromEntries([...pipeline.stages.map(row => row[1]), 'Squad Scribe']
    .map(agent => [agent, presence(root + `history/${agent}.md`)]));
  const manifest = { availability: presence(root + 'pipeline.json'), status: 'unavailable',
    stages: Object.fromEntries(pipeline.stages.map(([stage]) => [stage, false])) };
  let journal;
  try {
    journal = JSON.parse(read(root + 'pipeline.json'));
    manifest.status = ['complete', 'blocked'].includes(journal?.status) ? journal.status : 'invalid';
    for (const [index, [stage, agent]] of pipeline.stages.entries()) {
      manifest.stages[stage] = journal?.stages?.[index]?.stage === stage &&
        journal.stages[index].agent === agent;
    }
  } catch { if (manifest.availability === 'regular') manifest.status = 'invalid'; }
  const native = bound ? runtime.inspectEvents(path.join(bound.home, 'session-state',
    bound.sessionId, 'events.jsonl'), bound.request) : { availability: 'unavailable', calls: [], pending: 0 };
  const counts = Object.fromEntries([...pipeline.stages.map(row => row[1]), 'Squad Scribe']
    .map(agent => [agent, native.calls.filter(call => call.agent === agent).length]));
  const memberRead = filename => {
    // The manifest may name an artifact, but never arbitrary private/repository
    // paths, traversal, Windows separators or alternate data streams.
    p.check(/^(?:research|plans|changes|reviews|history)\/[^\\:\u0000-\u001f]+$/.test(filename) ||
      filename === 'pipeline.json', 'Invalid progress artifact path');
    p.check(!filename.split('/').some(part => ['.', '..', ''].includes(part)),
      'Progress traversal denied');
    return read(root + filename);
  };
  const verified = Object.fromEntries(pipeline.stages.map(([stage]) => [stage, false]));
  if (bound && native.proof && Array.isArray(journal?.stages)) {
    for (let length = 1; length <= pipeline.stages.length; length++) {
      try {
        const prefix = { ...journal, status: 'blocked', blockingReason: 'Prefix validation',
          stages: journal.stages.slice(0, length) };
        p.check(prefix.stages.length === length, 'Missing prefix');
        pipeline.validate(bound.request, file => file === 'pipeline.json' ?
          JSON.stringify(prefix) : memberRead(file));
        const last = native.calls.find(call => call.agent === pipeline.stages[length - 1][1]);
        const scribe = native.calls.find(call => call.agent === 'Squad Scribe' &&
          call.started > last?.completed);
        p.check(scribe, 'Missing serialized history handoff');
        pipeline.validateDispatch({ ...native.proof,
          calls: native.calls.filter(call => call.completed <= scribe.completed) },
        bound.request, prefix, bound.runAttempt);
        verified[pipeline.stages[length - 1][0]] = true;
      } catch { break; }
    }
  }
  let valid = false;
  try {
    p.check(bound && native.proof, 'No native proof');
    pipeline.validate(bound.request, memberRead);
    pipeline.validateDispatch(native.proof, bound.request, journal, bound.runAttempt);
    const state = JSON.parse(read(root + 'state.json'));
    p.check(state.schemaVersion === '1.4' &&
      ['source', 'ref', 'eventId', 'actor'].every(key =>
        state.trigger?.[key] === bound.request[key]) &&
      /^autopilot-run-[A-Za-z0-9_-]{1,128}$/.test(state.trigger?.runId || ''),
    'Missing final member provenance');
    for (const file of ['team.md', 'consumption.md', `history/${state.trigger.runId}.md`]) {
      p.check(read(root + file).trim(), 'Missing final event evidence');
    }
    p.check(read(`.copilot-tracking/squad/history/${sub}.md`).trim(), 'Missing final federation history');
    const sections = read(root + 'decisions.md').split(/^## Blocking findings[ \t]*\r?\n/m);
    p.check(sections.length > 1, 'Missing final findings heading');
    const findings = sections.at(-1).split(/^## /m)[0].trim();
    p.check(findings && findings.length <= 12000 &&
      (journal.status !== 'blocked' || findings.toLowerCase() !== 'none'),
    'Missing final blocking findings');
    valid = true;
  } catch {}
  let gate = false;
  try {
    const decisions = read(root + 'decisions.md');
    const findings = decisions.split(/^## Blocking findings[ \t]*\r?\n/m)[1]
      ?.split(/^## /m)[0]?.trim();
    gate = /\b(?:Risk Stop|cannot-confirm|over-ceiling|budget stop)\b/i.test(findings || '') ||
      /^(?:[-*]\s*)?(?:Risk Stop|cannot-confirm|over-ceiling)\s*[:—-]/im.test(decisions);
    const state = JSON.parse(read(root + 'state.json'));
    gate ||= state.currentRun?.costPreflight?.decision === 'over-ceiling' ||
      (Array.isArray(state.openEscalations) && state.openEscalations.length > 0);
  } catch {}
  return { root, histories, manifest, native, counts, journal, valid, verified, gate };
}

const actions = ['federation-init', 'member-init', 'native-unavailable', 'scribe',
  ...pipeline.stages.map(row => row[0]), 'finalize', 'complete', 'blocked', 'invalid-input'];

function hookStats() {
  try {
    const value = JSON.parse(read(path.join(privateRoot(), 'completion-status.json'), 4096));
    p.check(value.schemaVersion === 1 && Number.isInteger(value.checks) &&
      value.checks >= 0 && value.checks <= 255 && Number.isInteger(value.blocks) &&
      value.blocks >= 0 && value.blocks <= 8 && Number.isInteger(value.noProgress) &&
      value.noProgress >= 0 && value.noProgress <= 3 &&
      actions.includes(value.action) &&
      ['continuing', 'complete', 'blocked', 'block-limit', 'no-progress', 'invalid-input'].includes(value.status),
    'Invalid hook statistics');
    return { availability: 'regular', checks: value.checks, blocks: value.blocks,
      noProgress: value.noProgress, action: value.action, status: value.status };
  } catch { return { availability: 'unavailable' }; }
}

function diagnostics(sub) {
  let bound;
  try { bound = context(); p.check(bound.request.subSquad === sub, 'Wrong diagnostic member'); }
  catch { bound = undefined; }
  const value = inspect(sub, bound);
  return { roleHistory: value.histories, pipeline: value.manifest,
    native: { availability: value.native.availability, completed: value.counts,
      pending: value.native.pending }, completionHook: hookStats() };
}

module.exports = { read, presence, privateRoot, context, inspect, hookStats, diagnostics };
