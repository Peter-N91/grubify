'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('./policy.cjs');
const pipeline = require('./pipeline.cjs');
const progress = require('./progress.cjs');
const runtime = require('./runtime.cjs');

const guard = 'Remain in this session and its existing credit/time bounds. Never fabricate evidence, rerun a completed role, or override Risk Stop, cannot-confirm, budget or approval gates. PR Implement means static evidence-pack generation only: no source edits or PR code/tests.';

function initialize(sessionId) {
  p.check(/^[0-9a-f-]{36}$/.test(sessionId || ''), 'Invalid fixed session');
  const root = progress.privateRoot();
  const bytes = progress.read('.watch-run/request.json', 150000);
  p.check(/^[0-9a-f]{64}$/.test(process.env.EXPECTED_REQUEST_SHA256 || '') &&
    p.digest(bytes) === process.env.EXPECTED_REQUEST_SHA256, 'Invalid initial request');
  const request = JSON.parse(bytes);
  p.auditTargets(request.subSquad);
  p.check(/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT || ''), 'Invalid producing attempt');
  const value = { schemaVersion: 1, repoRoot: process.cwd(), sessionId,
    home: path.join(root, 'copilot-home'), requestSha256: process.env.EXPECTED_REQUEST_SHA256,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT };
  // The launcher creates the private directory before inference; never create
  // directories or any Squad/index/domain file from an agentStop invocation.
  fs.writeFileSync(path.join(root, 'completion-context.json'), JSON.stringify(value),
    { flag: 'wx', mode: 0o600 });
}

function next(value) {
  if (value.valid && (value.journal.status === 'blocked' || !value.gate)) {
    return { action: value.journal.status, stop: true };
  }
  // An explicit blocked result is never turned back into new domain work.
  if (value.manifest.status === 'blocked' || value.gate) return { action: 'finalize',
    reason: 'Preserve the declared block. Ask Squad Scribe to repair only the actual blocked-prefix journal, history, consumption and findings readback. Do NOT dispatch another domain role.' };
  if (!['valid', 'incomplete'].includes(value.native.availability)) return { action: 'native-unavailable',
    reason: 'Native dispatch evidence is unavailable/invalid. Do NOT repeat a role or infer completion from files. Preserve all gates; record an honest cannot-confirm blocked result through Squad Scribe if permitted. Final handoff remains fail-closed.' };
  const hasRoleWork = pipeline.stages.some(([, agent]) => value.counts[agent] > 0);
  if (!hasRoleWork && progress.presence('.copilot-tracking/squad/federation.md') !== 'regular') {
    return { action: 'federation-init', reason: 'Complete only the federation-scoped Scribe initialization/registration payload and readback, then the separate member initialization. Bootstrap is not terminal; no future role histories belong in initialization.' };
  }
  if (!hasRoleWork && (progress.presence(value.root + 'state.json') !== 'regular' ||
    progress.presence(value.root + 'team.md') !== 'regular' ||
    value.histories['Squad Scribe'] !== 'regular' || !value.counts['Squad Scribe'])) {
    return { action: 'member-init', reason: 'Ask Squad Scribe for the member-scoped initialization/repair with confirmed roster and ledgerCommand. Read back member state and history/Squad Scribe.md orchestration consumption, then proceed to Research. Do not invent future role histories.' };
  }
  for (const [index, [stage, agent, id]] of pipeline.stages.entries()) {
    if (!value.counts[agent]) {
      if (pipeline.stages.slice(index + 1).some(([, later]) => value.counts[later])) break;
      const previous = index ? pipeline.stages[index - 1][1] : null;
      if (previous && !value.verified[pipeline.stages[index - 1][0]]) break;
      return { action: stage, reason: `Bootstrap is not completion. Perform the next actual ${stage} stage using hve-squad:${id}, create its substantive artifact, then WAIT for a serialized member-scoped Squad Scribe history payload and readback before advancing.` };
    }
    const call = value.native.calls.find(call => call.agent === agent);
    const scribed = value.native.calls.some(item => item.agent === 'Squad Scribe' &&
      item.started > call.completed);
    if (!scribed || !value.verified[stage]) {
      return { action: 'scribe', reason: `The actual ${stage} role already completed. Do NOT rerun it. Ask hve-squad:squad-scribe for its member-scoped payloadType history with exact agent name ${agent}, actual artifact/outcome and consumption, plus this actual Scribe handoff's orchestration block in history/Squad Scribe.md. Verify history/${agent}.md and pipeline.json. Do not reinitialize.` };
    }
  }
  return { action: 'finalize', reason: 'Actual role evidence exists but final readback is incomplete/invalid. Ask Squad Scribe to repair only real stage artifacts/history/consumption, pipeline.json and final scoped decisions/run-summary evidence. Never repeat domain roles or claim missing evidence was executed.' };
}

function evaluate(input) {
  const bound = progress.context();
  p.check(input && input.sessionId === bound.sessionId && input.cwd === bound.repoRoot &&
    input.stopReason === 'end_turn' && typeof input.stop_hook_active === 'boolean',
  'Unsupported/unbound root stop input');
  // transcriptPath, timestamps, prose and every other input field are ignored.
  const value = progress.inspect(bound.request.subSquad, bound);
  let decision = next(value);
  const filename = path.join(progress.privateRoot(), 'completion-status.json');
  let previous = { checks: 0, blocks: 0, noProgress: 0 };
  if (progress.presence(filename) !== 'absent') {
    p.check(progress.hookStats().availability === 'regular', 'Invalid private hook state');
    previous = JSON.parse(progress.read(filename, 4096));
  }
  const fingerprint = p.digest(JSON.stringify({ counts: value.counts, histories: value.histories,
    manifest: value.manifest, verified: value.verified, gate: value.gate,
    availability: value.native.availability, action: decision.action }));
  const noProgress = previous.fingerprint === fingerprint ? Math.min(3, previous.noProgress + 1) : 0;
  let status = decision.stop ? decision.action : 'continuing';
  if (!decision.stop && (previous.blocks >= 8 || noProgress >= 3)) {
    status = previous.blocks >= 8 ? 'block-limit' : 'no-progress';
    decision = { ...decision, stop: true };
  }
  const record = { schemaVersion: 1, checks: Math.min(255, previous.checks + 1),
    blocks: previous.blocks + (decision.stop ? 0 : 1), noProgress,
    action: decision.action, status, fingerprint };
  runtime.regularPath(path.join(progress.privateRoot(), 'completion-context.json'), 4096);
  fs.writeFileSync(filename, JSON.stringify(record), { flag: previous.checks ? 'w' : 'wx', mode: 0o600 });
  return decision.stop ? {} : { decision: 'block', reason: `${decision.reason} ${guard}` };
}

if (require.main === module) {
  if (process.argv[2] === 'init') {
    try { initialize(process.argv[3]); } catch {
      console.error('::error::Completion hook binding unavailable; no model invocation permitted.');
      process.exitCode = 1;
    }
  } else {
    let bytes = '';
    let oversized = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (!oversized) {
        bytes += chunk;
        if (bytes.length > 16384) { bytes = ''; oversized = true; }
      }
    });
    process.stdin.on('end', () => {
      try {
        p.check(!oversized, 'Root stop input exceeds bound');
        // Plugin commands default to the plugin directory, not the checkout.
        // Only the launcher's fixed environment binding may select this root.
        p.check(path.isAbsolute(process.env.HVE_WATCH_REPO_ROOT || ''), 'Missing trusted hook cwd');
        process.chdir(process.env.HVE_WATCH_REPO_ROOT);
        process.stdout.write(JSON.stringify(evaluate(JSON.parse(bytes))) + '\n');
      }
      catch {
        console.error('Squad completion check could not validate its input or evidence; no completion is established.');
        process.stdout.write(JSON.stringify({ decision: 'block',
          reason: 'The completion check is unavailable or invalid. Do not claim completion or repeat domain roles. Preserve existing evidence and gates; record an honest cannot-confirm result through Squad Scribe if permitted. Stay within this session and its existing credit/time bounds. Final handoff remains fail-closed.' }) + '\n');
      }
    });
  }
}

module.exports = { initialize, evaluate, next };
