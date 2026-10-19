'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('./policy.cjs');

function outcome(value) {
  return ['success', 'failure', 'cancelled', 'skipped'].includes(value) ? value : 'unknown';
}

function report(sub, modelStep, handoffStep, exitCode) {
  p.auditTargets(sub);
  const root = `.copilot-tracking/squad/members/${sub}/`;
  const required = {
    federation: '.copilot-tracking/squad/federation.md',
    federationHistory: `.copilot-tracking/squad/history/${sub}.md`,
    memberState: root + 'state.json', roster: root + 'team.md',
    consumption: root + 'consumption.md', decisions: root + 'decisions.md'
  };
  let index;
  try { index = new Set(p.git(['ls-files', '-z']).toString('utf8').split('\0')); } catch {}
  const auditPresence = {};
  for (const [name, filename] of Object.entries(required)) {
    let disk = 'unsafe-or-unreadable';
    try {
      const stat = p.workingFile(filename, { maximumFileBytes: 1048576 });
      disk = stat?.isFile() ? 'regular' : stat ? 'not-file' : 'absent';
    } catch {}
    auditPresence[name] = { disk, index: index ? index.has(filename) : null };
  }
  const cliExitCode = /^(?:0|[1-9][0-9]{0,2})$/.test(exitCode || '') && Number(exitCode) <= 255
    ? Number(exitCode) : null;
  const missing = Object.values(auditPresence).some(file => file.disk !== 'regular' || file.index === false);
  const model = outcome(modelStep);
  const handoff = outcome(handoffStep);
  return {
    schemaVersion: 1, modelStep: model, handoffStep: handoff, cliExitCode,
    termination: cliExitCode === 124 || cliExitCode === 137 ? 'timeout-or-killed' :
      cliExitCode === 0 ? 'exited-zero' : cliExitCode === null ? 'unknown' : 'nonzero-exit',
    classification: model !== 'success' ? 'coordinator-not-successful' :
      handoff === 'success' ? 'validated-handoff' :
        missing ? 'incomplete-audit' : 'handoff-rejected',
    auditPresence, ...require('./progress.cjs').diagnostics(sub),
    limitation: 'Presence is not dispatch proof. Credit exhaustion and past model behavior are unknown; raw output is not published.'
  };
}

function stageError(error) {
  return error.code === 'SQUAD_AUDIT_INCOMPLETE' ? 'Incomplete Squad audit: coordinator exit zero is not completed bootstrap or dispatch. No handoff is permitted; inspect the safe runtime diagnostic.' :
    Number.isInteger(error.status) ? 'Git transport/index operation failed; no handoff is permitted.' :
      `Squad handoff rejected by scope, integrity or audit policy; no handoff is permitted. Policy code: ${p.digest(String(error.message || '')).slice(0, 12)}.`;
}

if (require.main === module) {
  try {
    const result = report(process.env.AUDIT_MEMBER, process.env.MODEL_OUTCOME,
      process.env.HANDOFF_OUTCOME, process.env.CLI_EXIT_CODE);
    fs.mkdirSync(process.env.DIAGNOSTIC_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.DIAGNOSTIC_DIR, 'runtime-status.json'),
      JSON.stringify(result, null, 2) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n### Squad runtime (safe metadata only)\n\n${JSON.stringify(result, null, 2)}\n`);
  } catch {
    console.error('::error::Safe Squad runtime diagnostic unavailable. No raw model output was published.');
    process.exitCode = 1;
  }
}

module.exports = { report, stageError };
