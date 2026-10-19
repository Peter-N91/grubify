'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('./policy.cjs');
const pipeline = require('./pipeline.cjs');

function assemble(destination) {
  p.check(!fs.existsSync(destination), 'Runtime plugin destination already exists');
  const agents = '.github/agents';
  const names = new Map();
  const files = fs.readdirSync(agents).filter(file => file.endsWith('.agent.md'));
  for (const file of files) {
    const source = p.text(p.regularFile(path.join(agents, file), 200000));
    const id = file.slice(0, -'.agent.md'.length);
    const name = /^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(source)?.[1] || id;
    p.check(!names.has(name), 'Duplicate deployed agent identity');
    names.set(name, id);
  }
  for (const agent of ['Squad Scribe', 'RPI Researcher', ...pipeline.stages.map(row => row[1])]) {
    p.check(names.has(agent), 'Required RPI agent is not deployed');
  }
  for (const skill of ['squad', 'rpi-research', 'rpi-plan', 'rpi-implement', 'rpi-review', 'code-review']) {
    p.regularFile(`.agents/skills/${skill}/SKILL.md`, 200000);
  }
  fs.mkdirSync(path.join(destination, 'agents', 'squad'), { recursive: true });
  fs.copyFileSync('scripts/squad-watch/runtime-plugin.json', path.join(destination, 'plugin.json'));
  fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'hooks'), { recursive: true });
  for (const name of ['policy', 'pipeline', 'runtime', 'progress', 'completion-gate']) {
    fs.copyFileSync(`scripts/squad-watch/${name}.cjs`, path.join(destination, 'scripts', `${name}.cjs`));
  }
  fs.copyFileSync('scripts/squad-watch/runtime-hooks.json', path.join(destination, 'hooks', 'hooks.json'));
  const models = new Map([
    ['Claude Haiku 4.5 (copilot)', 'claude-haiku-4.5'],
    ['Claude Sonnet 5 (copilot)', 'claude-sonnet-5'],
    ['GPT-6 Luna (copilot)', 'gpt-6-luna'],
    ['GPT-6 Sol (copilot)', 'gpt-6-sol']
  ]);
  for (const file of files) {
    let source = fs.readFileSync(path.join(agents, file), 'utf8').replace(/\r\n/g, '\n');
    // Adapt only the ephemeral runtime copy, never the integrity-checked APM assets.
    const end = source.indexOf('\n---', 4);
    p.check(source.startsWith('---\n') && end > 0, 'Unsupported deployed agent frontmatter');
    let header = source.slice(0, end);
    header = header.replace(/^model:\s*(.+)$/m, (_, model) => {
      const id = models.get(model.trim());
      p.check(id, 'Unmapped deployed agent model; review runtime adapter');
      return `model: ${id}`;
    });
    header = header.replace(/^agents:\n(?:[ \t]+-[^\n]*\n?)*/m, block => {
      const resolved = block.split('\n').slice(1).flatMap(line => {
        const name = /^\s+-\s+(.+)$/.exec(line)?.[1]?.trim();
        return names.has(name) ? [`  - hve-squad:${names.get(name)}\n`] : [];
      }).join('');
      return resolved ? 'agents:\n' + resolved : 'agents: []\n';
    });
    source = header + source.slice(end);
    fs.writeFileSync(path.join(destination, 'agents', 'squad', file), source);
  }
  fs.cpSync('.agents/skills', path.join(destination, 'skills'), { recursive: true, dereference: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'plugin.json')));
  manifest.skills = fs.readdirSync('.agents/skills').filter(name =>
    fs.existsSync(path.join('.agents/skills', name, 'SKILL.md'))).map(name => `skills/${name}/`);
  fs.writeFileSync(path.join(destination, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function observer(request) {
  let position = 0;
  const pending = new Map();
  const seen = new Set();
  const calls = [];
  const relevant = new Map(['Squad Scribe', ...pipeline.stages.map(row => row[1])]
    .map(name => [name, name]));
  for (const [ , name, id] of pipeline.stages) relevant.set(`hve-squad:${id}`, name);
  relevant.set('hve-squad:squad-scribe', 'Squad Scribe');
  function event(event) {
    position++;
    if (event.type === 'session.error' || event.type === 'abort' || event.type === 'subagent.failed') {
      throw new Error('Runtime reported failed/aborted dispatch');
    }
    if (!['subagent.started', 'subagent.completed'].includes(event.type)) return;
    const data = event.data || {};
    p.check(typeof data.toolCallId === 'string' && data.toolCallId.length > 0,
      'Unsupported CLI subagent event schema');
    if (event.type === 'subagent.started') {
      p.check(!seen.has(data.toolCallId), 'Duplicate runtime dispatch');
      seen.add(data.toolCallId);
      // Display names alone cannot turn a general-purpose child into a cast member.
      const name = relevant.get(data.agentName);
      const basename = data.agentName?.replace(/^hve-squad:/, '');
      const castName = name || pipeline.stages.find(row => row[2] === basename)?.[1] ||
        (basename === 'squad-scribe' ? 'Squad Scribe' : null);
      p.check(![...pending.values()].some(call => call.agent === 'Squad Scribe') &&
        (castName !== 'Squad Scribe' || pending.size === 0), 'Concurrent Scribe handoffs denied');
      pending.set(data.toolCallId, { agent: castName, started: position });
    } else {
      const call = pending.get(data.toolCallId);
      p.check(call && data.cancelled !== true, 'Unmatched/cancelled runtime dispatch');
      pending.delete(data.toolCallId);
      if (call.agent) calls.push({ ...call, completed: position });
    }
    p.check(calls.length <= 200 && pending.size <= 100, 'Runtime dispatch bound exceeded');
  }
  function finish() {
    p.check(pending.size === 0 && calls.length > 0, 'Incomplete or absent runtime dispatch telemetry');
    return { schemaVersion: 1, source: 'copilot-session-events', runId: request.runId,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      requestSha256: process.env.EXPECTED_REQUEST_SHA256,
      calls: calls.sort((a, b) => a.started - b.started) };
  }
  return { event, finish, snapshot: () => ({ calls: [...calls], pending: pending.size }) };
}

// Shared read-only scanner also works while a session is still open. An invalid
// stream may expose bounded counts for diagnostics, but never a usable proof.
function regularPath(filename, maximum) {
  const absolute = path.resolve(filename);
  const { root } = path.parse(absolute);
  const parts = path.relative(root, absolute).split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    p.check(!stat.isSymbolicLink(), 'Linked runtime path denied');
    p.check(index === parts.length - 1 ? stat.isFile() && stat.size <= maximum :
      stat.isDirectory(), 'Invalid runtime path');
  }
  return absolute;
}

function inspectEvents(filename, request) {
  const watcher = observer(request);
  let availability = 'invalid';
  let descriptor;
  try {
    const file = regularPath(filename, 128 * 1024 * 1024);
    if (!file) return { availability: 'missing', calls: [], pending: 0 };
    descriptor = fs.openSync(file, 'r');
    const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    const buffer = Buffer.alloc(65536);
    let remaining = '';
    let total = 0;
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
      total += size;
      p.check(total <= 128 * 1024 * 1024, 'Event stream bound exceeded');
      remaining += decoder.write(buffer.subarray(0, size));
      let end;
      while ((end = remaining.indexOf('\n')) >= 0) {
        const line = remaining.slice(0, end);
        p.check(line.length <= 8 * 1024 * 1024, 'Event line bound exceeded');
        if (line.trim()) watcher.event(JSON.parse(line));
        remaining = remaining.slice(end + 1);
      }
      p.check(remaining.length <= 8 * 1024 * 1024, 'Event line bound exceeded');
    }
    remaining += decoder.end();
    if (remaining.trim()) watcher.event(JSON.parse(remaining));
    const snapshot = watcher.snapshot();
    if (!snapshot.calls.length && snapshot.pending === 0) {
      return { availability: 'incomplete', ...snapshot };
    }
    const proof = watcher.finish();
    availability = 'valid';
    return { availability, proof, ...watcher.snapshot() };
  } catch {
    return { availability, ...watcher.snapshot() };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function collect(filename, request, destination) {
  const inspected = inspectEvents(filename, request);
  p.check(inspected.availability === 'valid', 'Missing/unsupported native dispatch telemetry');
  const proof = inspected.proof;
  fs.writeFileSync(destination, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return proof;
}

function readProof() {
  return JSON.parse(p.text(p.regularFile(path.join(process.env.RUNNER_TEMP,
    'squad-runtime', 'dispatch.json'), 100000)));
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    if (process.argv[2] === 'assemble') assemble(process.argv[3]);
    else if (process.argv[2] === 'collect') {
      const request = JSON.parse(fs.readFileSync('.watch-run/request.json', 'utf8'));
      await collect(process.argv[3], request, process.argv[4]);
    } else throw new Error('Expected assemble or collect');
  }).catch(() => {
    console.error('::error::Runtime bootstrap/dispatch evidence unavailable or invalid; no handoff permitted.');
    process.exitCode = 1;
  });
}

module.exports = { assemble, observer, collect, readProof, inspectEvents, regularPath };
