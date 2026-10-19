'use strict';

const p = require('./policy.cjs');

const stages = [
  ['Research', 'Squad Researcher', 'squad-researcher', 'research/'],
  ['Plan', 'Squad Lead', 'squad-lead', 'plans/'],
  ['Implement', 'Squad Implementor', 'squad-implementor', 'changes/'],
  ['Review', 'Squad Reviewer', 'squad-reviewer', 'reviews/']
];

const consumptionFields = [
  'model', 'model_source', 'priced_as', 'model_tier', 'internal_turns',
  'input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens', 'basis'
];
const consumptionStrings = ['model', 'model_source', 'priced_as', 'model_tier', 'basis'];

function hasConsumption(history, heading) {
  const pattern = new RegExp('^' + heading +
    '[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)*```json\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*(?=\\r?\\n|$)', 'gm');
  return [...history.matchAll(pattern)].some(match => {
    try {
      const block = JSON.parse(match[1]);
      // The installed ledger reads field order from one property per line.
      const order = [...match[1].matchAll(/^[ \t]*"([a-z_]+)"[ \t]*:/gm)].map(item => item[1]);
      return block && Object.keys(block).length === consumptionFields.length &&
        order.length === consumptionFields.length &&
        consumptionFields.every((field, index) => order[index] === field) &&
        consumptionStrings.every(field => typeof block[field] === 'string' && block[field].trim()) &&
        consumptionFields.filter(field => !consumptionStrings.includes(field))
          .every(field => Number.isFinite(block[field]) && block[field] >= 0) &&
        Number.isInteger(block.internal_turns) &&
        ['dispatch-reported', 'agent-pinned', 'operator-declared', 'session-inherited',
          'cli-pinned', 'unresolved'].includes(block.model_source) &&
        ['fast', 'default', 'extended'].includes(block.model_tier) &&
        ['estimated', 'tier-default'].includes(block.basis);
    } catch { return false; }
  });
}

function prompt(request) {
  return [
    'REQUIRED FOUR-STAGE SPINE (not a routed single-role turn): Research -> Plan ->',
    'Implement -> Review. Seed the default researcher, lead, developer, tester and',
    'scribe roster even for a small fix or PR event; retain task-fit council roles.',
    ...stages.map(([stage, agent, id, directory]) =>
      `${stage}: dispatch ${agent} using task agent_type="hve-squad:${id}"; ` +
      `its separate substantive artifact belongs under the event root's ${directory}.`),
    'Researcher must delegate bounded lanes to hve-squad:rpi-researcher with the',
    'complete primary-artifact/lane input contract. RPI skills are installed, not inline substitutes.',
    'Before the first role, dispatch hve-squad:squad-scribe for real bootstrap.',
    'After EACH stage, dispatch hve-squad:squad-scribe with that stage result, its',
    'artifact and consumption payload. WAIT for that Scribe to finish and verify',
    'history before starting the next role. Watch disables Scribe pipelining.',
    'The coordinator never writes domain deliverables, state, history or pipeline.json.',
    'Reviewer is a separate agent from Implementor; neither may substitute for the other.',
    'The Scribe records pipeline.json at the event root with schemaVersion:1,',
    `runId:"${request.runId}", status:"complete" or "blocked", blockingReason (string),`,
    'and stages:[{stage,agent,artifact,history}] in the exact order above. artifact',
    'and history are event-relative; history is exactly history/<Agent Display Name>.md.',
    'Each stage history must reference its artifact and stage, with a real Consumption',
    'JSON block, including Scribe orchestration consumption on history/Squad Scribe.md.',
    'Use exactly #### Consumption for roles and #### Consumption — Orchestration for',
    'Scribe, with no heading suffix, then a fenced json block with these ten fields',
    `in order, one per line: ${consumptionFields.join(', ')}.`,
    'Strings must be non-empty; numbers finite and nonnegative, internal_turns integer.',
    'Keep unknown/unresolved when the model attribution ladder cannot resolve a model.',
    'Update the journal only AFTER that stage actually ran; never preseed history.',
    'Complete requires all four stages. A real Risk Stop, missing role, cannot-confirm',
    'or budget stop records blocked plus the completed prefix and explicit Blocking findings;',
    'it never invents skipped work or claims a complete pipeline. No gate is waived.',
    ...(request.source === 'pr' ? [
      'PR RPI IS REVIEW PREPARATION, NOT SOURCE IMPLEMENTATION: Research inspects',
      'the immutable snapshot; Plan defines source checks and evidence questions;',
      'Implement executes that review-analysis plan, writing a static evidence pack',
      'under changes/ ONLY. It must not edit application code or execute PR code/tests.',
      'Review independently validates that evidence pack against the same source',
      'snapshot, writes reviews/ and review.json. testsExecuted stays false.',
      'This scoped artifact implementation does not authorize applying suggested fixes.'
    ] : [
      'Implement follows the researched plan within allowed application roots and',
      'writes its change/validation record under changes/. Review checks the actual',
      'uncommitted source diff against the plan; state/history alone are not review evidence.'
    ]),
    'Runtime admission also checks CLI-generated subagent lifecycle events. File',
    'presence, a coordinator summary, or a fabricated dispatch list cannot replace them.',
    'Do not edit or read the private runtime session/evidence files.'
  ];
}

function validate(request, read) {
  const journal = JSON.parse(read('pipeline.json'));
  p.check(journal.schemaVersion === 1 && journal.runId === request.runId &&
    ['complete', 'blocked'].includes(journal.status) &&
    typeof journal.blockingReason === 'string' && Array.isArray(journal.stages) &&
    journal.stages.length <= stages.length, 'Missing/mismatched RPI pipeline journal');
  p.check(journal.status === 'complete' ? journal.stages.length === stages.length :
    journal.blockingReason.trim().length > 0, 'Incomplete RPI cannot claim completion');
  const artifacts = new Set();
  for (const [index, entry] of journal.stages.entries()) {
    const [stage, agent, , directory] = stages[index];
    p.check(entry.stage === stage && entry.agent === agent &&
      entry.history === `history/${agent}.md` && typeof entry.artifact === 'string' &&
      entry.artifact.startsWith(directory) && !entry.artifact.includes('..') &&
      !artifacts.has(entry.artifact), 'RPI stage order/role/domain artifact mismatch');
    artifacts.add(entry.artifact);
    p.check(read(entry.artifact).trim().length >= 40, 'Missing substantive RPI domain artifact');
    const history = read(entry.history);
    p.check(history.includes(entry.artifact) && history.includes(stage),
      'Missing stage-specific Scribe history');
    p.check(hasConsumption(history, '#### Consumption'), 'Missing per-stage consumption evidence');
  }
  const scribe = read('history/Squad Scribe.md');
  p.check(scribe.trim().length >= 40, 'Missing actual Scribe history');
  p.check(hasConsumption(scribe, '#### Consumption — Orchestration'),
    'Missing Scribe orchestration consumption evidence');
  return journal;
}

function validateDispatch(proof, request, journal, producerAttempt) {
  p.check(proof?.schemaVersion === 1 && proof.source === 'copilot-session-events' &&
    proof.runId === request.runId && proof.runAttempt === producerAttempt &&
    proof.requestSha256 === process.env.EXPECTED_REQUEST_SHA256 &&
    Array.isArray(proof.calls) && proof.calls.length <= 200,
  'Missing/mismatched runtime dispatch evidence');
  let previous = 0;
  const calls = proof.calls;
  const known = new Set(['Squad Scribe', ...stages.map(row => row[1])]);
  const positions = new Set();
  for (const call of calls) {
    p.check(known.has(call.agent) && Number.isSafeInteger(call.started) &&
      Number.isSafeInteger(call.completed) && call.started > 0 &&
      call.completed > call.started && !positions.has(call.started) &&
      !positions.has(call.completed), 'Invalid runtime dispatch lifecycle');
    positions.add(call.started);
    positions.add(call.completed);
    if (call.agent === 'Squad Scribe') {
      p.check(calls.every(other => other === call || other.completed < call.started ||
        other.started > call.completed), 'Concurrent Scribe handoffs denied');
    }
    for (const [, agent] of stages) {
      p.check(calls.filter(call => call.agent === agent).length ===
        journal.stages.filter(stage => stage.agent === agent).length,
      'Unexpected or unrecorded RPI role dispatch');
    }
  }
  for (const stage of journal.stages) {
    const call = calls.find(item => item.agent === stage.agent && item.started > previous);
    p.check(call && calls.some(item => item.agent === 'Squad Scribe' &&
      item.started > previous && item.completed < call.started),
    'RPI requires actual ordered role dispatch and prior serialized Scribe handoff');
    previous = call.completed;
  }
  p.check(calls.some(item => item.agent === 'Squad Scribe' && item.started > previous),
    'Missing final serialized Scribe handoff');
  return proof;
}

function sourceGate(request, journal, changes) {
  p.check(request.source === 'pr' || journal.stages.some(stage => stage.stage === 'Implement') ||
    changes.every(file => file.path.startsWith('.copilot-tracking/squad/')),
  'Application changes require an actually completed Implement stage');
}

module.exports = { stages, prompt, validate, validateDispatch, sourceGate };
