'use strict';

// Synthetic contracts only, never evidence for a real paid run.
const fs = require('node:fs');
const path = require('node:path');
const { stages } = require('./pipeline.cjs');
const { observer } = require('./runtime.cjs');

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

module.exports = { pipelineFixture, consumptionFixture, consumptionBlock };
