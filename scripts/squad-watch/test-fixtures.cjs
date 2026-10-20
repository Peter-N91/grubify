'use strict';

// Synthetic contracts only, never evidence for a real paid run.
const fs = require('node:fs');
const path = require('node:path');
const { stages } = require('./pipeline.cjs');
const { observer } = require('./runtime.cjs');
const completion = require('./completion-gate.cjs');

function consumptionFixture() {
  return {
    model: 'unknown', model_source: 'unresolved', priced_as: 'Claude Sonnet 4.6', model_tier: 'default',
    internal_turns: 0, input_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0,
    basis: 'tier-default'
  };
}

function consumptionBlock(heading = '#### Consumption', block = consumptionFixture()) {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
}

function pipelineFixture(request, write) {
  const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
  const journal = { schemaVersion: 1, runId: request.runId, status: 'complete',
    blockingReason: '', stages: [] };
  const events = [];
  let id = 0;
  function dispatch(agentName) {
    const data = { agentName, toolCallId: String(++id) };
    events.push({ type: 'subagent.started', data }, { type: 'subagent.completed', data });
  }
  dispatch('hve-squad:squad-scribe');
  for (const [stage, agent, slug, directory] of stages) {
    const artifact = `${directory}pipeline-fixture.txt`;
    journal.stages.push({ stage, agent, artifact, history: `history/${agent}.md` });
    write(root + artifact,
      `Synthetic ${stage} domain evidence only, NOT actual dispatch. GrubifyApi/Reviewed.cs:1\n`);
    write(root + `history/${agent}.md`,
      `# History: ${agent}\n\n### Synthetic ${stage} — NOT live dispatch\n\n` +
      `* Turn: 0\n* Request: Offline synthetic ${stage} contract\n` +
      `* Deliverable: ${artifact}\n* Outcome: Synthetic fixture only; estimated, not billed.\n\n` +
      consumptionBlock());
    dispatch(`hve-squad:${slug}`);
    dispatch('hve-squad:squad-scribe');
  }
  write(root + 'history/Squad Scribe.md',
    '# History: Squad Scribe\n\n### Synthetic Scribe handoffs — NOT an actual model run\n\n' +
    '* Turn: 0\n* Request: Offline synthetic handoff contracts\n' +
    '* Deliverable: state.json, pipeline.json, history/*.md\n' +
    '* Outcome: Synthetic fixture only; estimated, not billed.\n\n' +
    consumptionBlock('#### Consumption — Orchestration'));
  write(root + 'pipeline.json', JSON.stringify(journal));
  const watcher = observer(request);
  events.forEach(watcher.event);
  write(path.join(process.env.RUNNER_TEMP, 'squad-runtime', 'dispatch.json'), JSON.stringify(watcher.finish()));
  return { journal, events, root };
}

function completionFixture(request, write, action) {
  const previous = { RUNNER_TEMP: process.env.RUNNER_TEMP,
    EXPECTED_REQUEST_SHA256: process.env.EXPECTED_REQUEST_SHA256 };
  const runner = path.join(previous.RUNNER_TEMP, 'completion-' + require('node:crypto').randomUUID());
  process.env.RUNNER_TEMP = runner;
  const bytes = JSON.stringify(request);
  process.env.EXPECTED_REQUEST_SHA256 = require('./policy.cjs').digest(bytes);
  write('.watch-run/request.json', bytes);
  const sessionId = require('node:crypto').randomUUID();
  const home = path.join(runner, 'squad-runtime', 'copilot-home');
  fs.mkdirSync(home, { recursive: true });
  completion.initialize(sessionId);
  const filename = path.join(home, 'session-state', sessionId, 'events.jsonl');
  const input = { sessionId, cwd: process.cwd(), timestamp: 1,
    stopReason: 'end_turn', stop_hook_active: false, transcriptPath: 'NEVER READ THIS INPUT' };
  const events = names => names.flatMap((agentName, index) => [
    { type: 'subagent.started', data: { toolCallId: String(index), agentName } },
    { type: 'subagent.completed', data: { toolCallId: String(index) } }
  ]);
  const cleanup = () => {
    Object.assign(process.env, previous);
    fs.rmSync(runner, { recursive: true, force: true });
  };
  let pending = false;
  try {
    const result = action({ input, filename, home, events,
      native: value => write(filename, value.map(event => JSON.stringify(event)).join('\n')) });
    if (result && typeof result.then === 'function') {
      pending = true;
      return Promise.resolve(result).finally(cleanup);
    }
    return result;
  } finally {
    if (!pending) cleanup();
  }
}

module.exports = { pipelineFixture, consumptionFixture, consumptionBlock, completionFixture };
