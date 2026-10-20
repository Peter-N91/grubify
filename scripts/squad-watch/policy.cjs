'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder, isDeepStrictEqual } = require('node:util');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function config() {
  return JSON.parse(fs.readFileSync('.github/squad-watch.json', 'utf8'));
}

function integer(value, name) {
  check(/^[1-9][0-9]*$/.test(String(value)), `Invalid ${name}`);
  const number = Number(value);
  check(Number.isSafeInteger(number), `Invalid ${name}`);
  return number;
}

function credits(value, cfg) {
  const cap = value === '' || value === undefined
    ? cfg.defaultAiCredits : integer(value, 'AI credit cap');
  check(cap >= 30 && cap <= cfg.maximumAiCredits, 'AI credit cap must be 30..configured maximum');
  return cap;
}

function watchAuditContract(request) {
  return [
    'PHASE 1 — BOOTSTRAP STATE ONLY: complete initialization before domain work. Do',
    'not improvise legacy headers or state keys. federation.md must contain the exact',
    'six-column header "| Sub-squad | Profile | Kind | Location | Owner | Description |"',
    `and exactly one current row whose cells are "${request.subSquad}", a profile,`,
    `"in-repo", "members/${request.subSquad}/", "watch-mode", and a description`,
    `that contains "${request.ref}". meta-routing.md must use the exact header`,
    '"| Pattern / Domain | Sub-squad | Parallel-Eligible |" and current row',
    `"| watch: ${request.ref} | ${request.subSquad} | no |".`,
    'Federation state.json must use schemaVersion "1.3", include subSquads and',
    `activeSubSquads arrays containing only "${request.subSquad}" on blank init, and`,
    'use no keys beyond schemaVersion, updated, turn, mode, subSquads,',
    'activeSubSquads, openEscalations, currentRun and notify. Keep openEscalations',
    'empty and notify disabled; omit currentRun rather than inventing spend.',
    `Member state.json must use schemaVersion "1.4" and trigger.source="${request.source}",`,
    `trigger.ref="${request.ref}", trigger.eventId="${request.eventId}",`,
    `trigger.actor="${request.actor}", and trigger.runId="autopilot-run-<id>".`,
    'The member initialization seeds team.md, routing.md, consumption.md,',
    'consumption-rates.md, decisions.md, notifications.md and history/Squad Scribe.md',
    'with this actual initialization handoff Consumption — Orchestration block.',
    'Use references/scribe-payload-template.md: exactly ONE payloadType and ONE',
    'squadRoot per Scribe dispatch. On blank init, first send payloadType initialization',
    'at squadRoot .copilot-tracking/squad/ with confirmed federation registry,',
    'meta-routes, notify and initial member-history names; explicitly load',
    'references/scribe-cold-federation.md. This does NOT initialize the member.',
    `Then send a separate payloadType initialization at squadRoot .copilot-tracking/squad/members/${request.subSquad}/`,
    'with the coordinator-resolved full roster rows and ledgerCommand. Load',
    'references/scribe-cold-init-and-seeding.md; never derive or shorten agent names.',
    'Member initialization expectedPostWriteCounts: zero role-history entries,',
    'one new Scribe orchestration consumption block. Federation member-history',
    'records carry no role consumption, per the federation history contract.',
    'Wait and read back each scope before the next dispatch. Reuse verified owned',
    'state without replacing prior bytes; repair missing initialization via Scribe.',
    'Bootstrap does NOT require future role histories or a completed run summary.',
    'Never preseed role history to satisfy a final validator. Once bootstrap reads',
    'back correctly, immediately dispatch Research; initialization is NOT terminal.',
    'PHASE 2 — FINAL HANDOFF ONLY, after actual work or a genuine blocked prefix:',
    'decisions.md needs exactly "## Blocking findings"; member',
    'history/autopilot-run-<id>.md summarizes the actual targeted member run.',
    'For the inner-run summary use the member autopilot-run schema in',
    'references/scribe-cold-gates-and-verdicts.md with payloadType autopilot-run summary',
    'scoped to the member. This is NOT a federation meta-run summary; do not apply',
    'the federation-only summary template or overwrite shared aggregate totals.',
    `Federation history/${request.subSquad}.md records real registration/outcome.`,
    'Every completed stage needs its exact role history and actual artifact; Scribe',
    'orchestration history and pipeline.json must reflect only real dispatches.',
    'Re-read final evidence before returning. Malformed/partial evidence is not completion.'
  ];
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function issueHash(issue) {
  return digest(JSON.stringify({ number: issue.number, title: issue.title, body: issue.body || '' }));
}

async function authorized(github, repo, actors) {
  for (const username of new Set(actors)) {
    if (!username) return false;
    try {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...repo, username });
      if (!['write', 'admin', 'maintain'].includes(data.permission)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validIssue(issue, cfg, needsLabel) {
  check(!issue.pull_request && issue.state === 'open', 'Target must be an OPEN issue, not a PR');
  if (needsLabel) {
    check((issue.labels || []).some(label => (label.name || label) === cfg.issueLabel),
      'Opt-in label was removed; refusing run');
  }
}

async function branchExists(github, repo, branch) {
  try {
    await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

function attempt(value, name = 'run attempt') {
  integer(value, name);
  check(typeof value === 'string', `Invalid ${name}`);
  return Number(value);
}

function requestBytes() {
  return regularFile(path.join(process.env.REQUEST_DIR, 'request.json'), 150000);
}

function execution(request) {
  const origin = attempt(request.runAttempt, 'request origin attempt');
  const expected = attempt(process.env.EXPECTED_REQUEST_ATTEMPT, 'request producer attempt');
  const current = attempt(process.env.GITHUB_RUN_ATTEMPT);
  check(origin === expected && origin <= current, 'Request producer attempt mismatch');
  integer(request.runId, 'request run ID');
  check(request.runId === process.env.GITHUB_RUN_ID &&
    process.env.EXPECTED_REQUEST_ARTIFACT === `squad-request-${request.runId}-${request.runAttempt}`,
  'Request producer artifact mismatch');
  integer(process.env.EXPECTED_REQUEST_ARTIFACT_ID, 'request artifact ID');
  check(/^[0-9a-f]{64}$/.test(process.env.EXPECTED_REQUEST_SHA256 || '') &&
    digest(requestBytes()) === process.env.EXPECTED_REQUEST_SHA256, 'Immutable request hash mismatch');
  return { runAttempt: String(current), requestRunAttempt: request.runAttempt,
    runId: request.runId, requestSha256: process.env.EXPECTED_REQUEST_SHA256,
    requestArtifact: process.env.EXPECTED_REQUEST_ARTIFACT,
    requestArtifactId: process.env.EXPECTED_REQUEST_ARTIFACT_ID,
    triggeringActor: process.env.TRIGGERING_ACTOR };
}

async function revalidateCurrent({ github, context }) {
  const cfg = config();
  const request = JSON.parse(text(requestBytes()));
  execution(request);
  check(request.schemaVersion === 1 && request.repository === cfg.repository &&
    request.repository === `${context.repo.owner}/${context.repo.repo}` &&
    context.ref === `refs/heads/${cfg.defaultBranch}` &&
    request.baseBranch === cfg.defaultBranch && request.baseSha === process.env.EXPECTED_BASE_SHA &&
    request.baseSha === context.sha && /^[0-9a-f]{40}$/.test(request.baseSha) &&
    String(request.issue) === process.env.EXPECTED_ISSUE && integer(request.issue, 'issue') === request.issue &&
    request.subSquad === `issue-${request.issue}` && request.branch === `squad/issue-${request.issue}` &&
    request.ref === `${cfg.repository}#${request.issue}` && request.runId === String(context.runId) &&
    request.actor === context.actor && typeof request.triggeringActor === 'string' &&
    request.model === cfg.model && credits(String(request.maxAiCredits), cfg) === request.maxAiCredits,
  'Trusted request provenance/configuration mismatch');
  const manual = context.eventName === 'workflow_dispatch';
  check(request.source === (manual ? 'workflow_dispatch' : 'issue') &&
    (manual || (context.eventName === 'issues' && context.payload.action === 'labeled' &&
      context.payload.label?.name === cfg.issueLabel)), 'Invalid request source/event');
  check(integer(manual ? context.payload.inputs?.issue_number : context.payload.issue?.number,
    'event issue') === request.issue, 'Request/event issue mismatch');
  check(await authorized(github, context.repo,
    [request.actor, request.triggeringActor, process.env.TRIGGERING_ACTOR]),
  'Collaborator authorization changed (initial/producer/current rerun actor)');
  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: request.issue });
  validIssue(issue, cfg, !manual);
  check(issueHash(issue) === request.issueHash && request.eventId === `issues:${issue.id}`,
    'Issue changed since opt-in snapshot; preview and retrigger');
  const { data: repo } = await github.rest.repos.get(context.repo);
  check(repo.default_branch === cfg.defaultBranch, 'Default branch changed');
  const { data: base } = await github.rest.repos.getBranch({ ...context.repo, branch: cfg.defaultBranch });
  check(base.commit.sha === request.baseSha, 'Main changed since snapshot; retrigger on current main');
  check(!await branchExists(github, context.repo, request.branch), 'Event branch already exists; never overwrite it');
  const { data: pulls } = await github.rest.pulls.list({
    ...context.repo, state: 'all', head: `${context.repo.owner}:${request.branch}`, per_page: 1
  });
  check(pulls.length === 0, 'Event PR already exists; no duplicate or update');
  return { request, cfg };
}

function git(args, options = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(process.cwd(), '.watch-run', 'empty-gitconfig') };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GIT_CONFIG_COUNT']) delete env[key];
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', ...args],
  { env, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024, ...options });
}

function text(bytes) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  check(!value.includes('\0'), 'Binary/NUL content is not allowed');
  return value;
}

function safePath(filename, cfg, sub) {
  check(typeof filename === 'string' && filename.length <= 240 &&
    /^[A-Za-z0-9_. \/-]+$/.test(filename), 'Unsafe artifact path');
  const parts = filename.split('/');
  check(parts.every(part => part && part === part.trim() && !part.endsWith('.') &&
    part !== '.' && part !== '..' && !part.toLowerCase().startsWith('.git') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
    'Unsafe artifact path segment');
  check(!parts.some(part => /^(?:\.env(?:\..*)?|\.gitattributes|\.gitmodules|\.npmrc|\.yarnrc(?:\..*)?|\.netrc|credentials|secrets?)(?:$|\.)/i.test(part)),
    'Credential or executable configuration path denied');
  check(!/\.(?:pem|key|pfx|p12|crt|kdbx|log)$/i.test(filename), 'Sensitive/log file denied');
  const root = '.copilot-tracking/squad/';
  const meta = ['federation.md', 'meta-routing.md', 'decisions.md', 'state.json',
    'consumption.md', 'consumption-rates.md', `history/${sub}.md`];
  const allowed = cfg.allowedCodeRoots.some(prefix => filename.startsWith(prefix)) ||
    filename.startsWith(`${root}members/${sub}/`) ||
    meta.some(name => filename === root + name);
  check(allowed, 'Artifact path is outside approved app/event audit scope');
  check(!/(?:^|\/)(?:sessions?|transcripts?|logs?|node_modules|apm_modules)(?:\/|$)/i.test(filename),
    'Runtime/session/dependency material denied');
  return filename;
}

function sanitized(value) {
  check(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]+|\bgh[pousr]_[A-Za-z0-9]+|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|SharedAccessSignature\s*=|AccountKey\s*=\s*[A-Za-z0-9+/=]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i.test(value),
  'Possible credential in output; human sanitization required');
  return value;
}

function auditTargets(sub) {
  check(/^(?:issue|pr)-[1-9][0-9]*$/.test(sub), 'Invalid event audit member');
  const root = '.copilot-tracking/squad/';
  return ['federation.md', 'meta-routing.md', 'decisions.md', 'state.json',
    'consumption.md', 'consumption-rates.md', `history/${sub}.md`, `members/${sub}`]
    .map(filename => root + filename);
}

function workingFile(filename, cfg) {
  const parts = filename.split('/');
  for (let i = 1; i <= parts.length; i++) {
    let stat;
    try { stat = fs.lstatSync(parts.slice(0, i).join('/')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    check(!stat.isSymbolicLink(), 'Symlink audit/artifact path denied');
    if (i < parts.length) check(stat.isDirectory(), 'Non-directory artifact parent denied');
    else {
      check(stat.isFile() || stat.isDirectory(), 'Non-regular artifact denied');
      if (stat.isFile()) check(stat.size <= cfg.maximumFileBytes, 'Changed file exceeds size bound');
      return stat;
    }
  }
}

function proposalPaths(cfg, sub, validate = filename => safePath(filename, cfg, sub)) {
  const paths = new Set(git(['ls-files', '--modified', '--deleted', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean));
  let visited = 0;
  // Squad state is normally ignored. Visit only exact shared files and this
  // event member, never a broad force-add of the ignored federation or repo.
  function visit(filename) {
    check(++visited <= cfg.maximumFiles * 4, 'Audit traversal exceeds size bound');
    const stat = workingFile(filename, cfg);
    if (!stat) return;
    if (stat.isDirectory()) {
      validate(`${filename}/audit-path-check.md`);
      const directory = fs.opendirSync(filename);
      try {
        let entry;
        while ((entry = directory.readSync())) visit(`${filename}/${entry.name}`);
      } finally { directory.closeSync(); }
    } else {
      validate(filename);
      paths.add(filename);
      check(paths.size <= cfg.maximumFiles, 'Too many proposed files');
    }
  }
  for (const filename of auditTargets(sub)) visit(filename);
  check(paths.size <= cfg.maximumFiles, 'Too many proposed files');
  for (const filename of paths) {
    validate(filename);
    const stat = workingFile(filename, cfg);
    check(!stat || stat.isFile(), 'Only regular proposed files are allowed');
  }
  return [...paths].sort();
}

function stageProposal(cfg, sub, validate) {
  const paths = proposalPaths(cfg, sub, validate);
  // Every explicit path was checked before -f; ignored app/dependency trees
  // and other members are not candidates. Tracked deletions stay included.
  if (paths.length) git(['add', '-f', '-A', '--', ...paths]);
  return paths;
}

function changes(cfg, sub) {
  const entries = git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-ext-diff']).toString('utf8').split('\0');
  const result = [];
  for (let i = 0; i < entries.length - 1; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMD])$/.exec(entries[i]);
    check(match, 'Unsupported patch status (no renames, symlinks or submodules)');
    const filename = safePath(entries[i + 1], cfg, sub);
    const [, oldMode, newMode, status] = match;
    check((oldMode === '000000' || oldMode === '100644') &&
      (newMode === '000000' || newMode === '100644'), 'Only ordinary non-executable files are allowed');
    const bytes = status === 'D' ? null : git(['show', `:${filename}`]);
    if (bytes) {
      check(bytes.length <= cfg.maximumFileBytes, 'Changed file exceeds size bound');
      sanitized(text(bytes));
    }
    check(!(status === 'D' && filename.startsWith('.copilot-tracking/')), 'Audit trail deletion denied');
    if (status === 'M' && /(?:^|\/)(?:decisions\.md|consumption\.md|history\/[^/]+\.md)$/.test(filename)) {
      const previous = git(['show', `HEAD:${filename}`]);
      check(bytes.subarray(0, previous.length).equals(previous), 'Append-only audit was rewritten');
    }
    result.push({ path: filename, status, mode: newMode, bytes });
  }
  check(result.length <= cfg.maximumFiles, 'Too many changed files');
  return result;
}

function readStaged(filename) {
  const entries = git(['ls-files', '--stage', '-z', '--', filename]).toString('utf8').split('\0');
  if (!entries.some(entry => entry.endsWith(`\t${filename}`) && /^100644 [0-9a-f]+ 0\t/.test(entry))) {
    const error = new Error('Incomplete Squad audit: required artifact absent from index. ' +
      'Coordinator exit zero does not prove completed bootstrap or dispatch; no handoff is permitted.');
    error.code = 'SQUAD_AUDIT_INCOMPLETE';
    throw error;
  }
  return sanitized(text(git(['show', `:${filename}`])));
}

function baseAudit(request) {
  check(/^[0-9a-f]{40}$/.test(request.baseSha), 'Invalid audit base SHA');
  const files = new Map();
  const entries = git(['ls-tree', '-r', '-z', request.baseSha, '--', '.copilot-tracking/squad/'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    check(match, 'Unsupported trusted audit tree entry');
    files.set(match[2], git(['cat-file', 'blob', match[1]]));
  }
  return files;
}

function table(value, header, width) {
  const rows = [];
  for (const line of value.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.trim().split('|').slice(1, -1).map(cell => cell.trim());
    check(cells.length === width, 'Malformed shared audit table');
    if (cells[0] === header || cells.every(cell => /^:?-+:?$/.test(cell))) continue;
    rows.push({ line, cells });
  }
  return rows;
}

function mentionsRef(value, ref) {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9/#-])${escaped}(?![A-Za-z0-9/#-])`).test(value);
}

function memberBase(request, base) {
  const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
  const registry = base.get('.copilot-tracking/squad/federation.md');
  const rows = registry ? table(text(registry), 'Sub-squad', 6) : [];
  check(new Set(rows.map(row => row.cells[0])).size === rows.length, 'Duplicate base registry member');
  const row = rows.find(row => row.cells[0] === request.subSquad);
  if (row) check(row.cells[4] === 'watch-mode' && row.cells[2] === 'in-repo' &&
    row.cells[3] === `members/${request.subSquad}/` && mentionsRef(row.cells[5], request.ref),
  'Trusted base member is not watch-owned for this event');
  if (row || [...base.keys()].some(filename => filename.startsWith(root))) {
    const bytes = base.get(root + 'state.json');
    check(bytes, 'Existing event member lacks trusted provenance');
    const state = JSON.parse(text(bytes));
    check(state.trigger?.ref === request.ref && state.trigger.eventId === request.eventId,
      'Existing event member has mismatched trusted provenance');
  }
  check(registry || !base.has('.copilot-tracking/squad/team.md'),
    'Human single-squad promotion requires separately reviewed policy');
}

function preserveTable(previous, proposed, header, width, targetColumn, request, validate) {
  const rows = table(proposed, header, width);
  if (header === 'Sub-squad') check(new Set(rows.map(row => row.cells[targetColumn])).size === rows.length,
    'Duplicate shared audit registration');
  const current = rows.filter(row => row.cells[targetColumn] === request.subSquad);
  check(current.length === 1, 'Missing/duplicate current event registry or route');
  validate(current[0].cells);
  const oldRows = previous ? table(text(previous), header, width) : [];
  for (const row of rows) {
    check(row.cells[targetColumn] === request.subSquad ||
      oldRows.some(old => old.line === row.line), 'Unapproved shared audit registration');
  }
  if (previous) {
    const oldCurrent = oldRows.filter(row => row.cells[targetColumn] === request.subSquad);
    check(oldCurrent.length <= 1, 'Duplicate trusted event registration');
    if (oldCurrent.length) check(current[0].line === oldCurrent[0].line,
      'Existing event registration was rewritten');
    const strip = value => value.split('\n').filter(line =>
      !table(line, header, width).some(row => row.cells[targetColumn] === request.subSquad)).join('\n');
    check(strip(text(previous)) === strip(proposed), 'Unrelated shared audit content was changed');
  }
}

function sharedAudit(request, base) {
  const root = '.copilot-tracking/squad/';
  memberBase(request, base);
  const federation = readStaged(root + 'federation.md');
  preserveTable(base.get(root + 'federation.md'), federation,
    'Sub-squad', 6, 0, request, cells => {
      check(cells[2] === 'in-repo' && cells[3] === `members/${request.subSquad}/` &&
        cells[4] === 'watch-mode' && mentionsRef(cells[5], request.ref),
      'Missing watch-owned federation registry row');
    });
  const stagedPaths = git(['ls-files', '-z']).toString('utf8').split('\0');
  if (stagedPaths.includes(root + 'meta-routing.md')) {
    preserveTable(base.get(root + 'meta-routing.md'), readStaged(root + 'meta-routing.md'),
      'Pattern / Domain', 3, 1, request, cells => {
        check(cells[0] === `watch: ${request.ref}` && cells[2] === 'no', 'Event route must be narrow and nonparallel');
      });
  } else check(!base.has(root + 'meta-routing.md'), 'Existing routing metadata was removed');
  if (stagedPaths.includes(root + 'state.json')) {
    const state = JSON.parse(readStaged(root + 'state.json'));
    const previous = base.has(root + 'state.json') ? JSON.parse(text(base.get(root + 'state.json'))) : null;
    const registered = table(federation, 'Sub-squad', 6).map(row => row.cells[0]);
    check(Array.isArray(state.subSquads) && state.subSquads.includes(request.subSquad) &&
      new Set(state.subSquads).size === state.subSquads.length &&
      JSON.stringify([...state.subSquads].sort()) === JSON.stringify([...registered].sort()),
    'Invalid shared member list');
    const unrelated = names => names.filter(name => name !== request.subSquad);
    check(JSON.stringify(unrelated(state.subSquads)) ===
      JSON.stringify(unrelated(previous?.subSquads || registered)),
      'Unrelated shared member state changed');
    check(Array.isArray(state.activeSubSquads) &&
      state.activeSubSquads.every(name => name === request.subSquad ||
        previous?.activeSubSquads?.includes(name)), 'Unapproved shared active member');
    if (previous) {
      check(JSON.stringify(unrelated(state.activeSubSquads)) ===
        JSON.stringify(unrelated(previous.activeSubSquads || [])), 'Unrelated active member state changed');
      for (const key of new Set([...Object.keys(previous), ...Object.keys(state)])) {
        if (['updated', 'turn', 'subSquads', 'activeSubSquads'].includes(key)) continue;
        check(isDeepStrictEqual(state[key], previous[key]), 'Unnecessary shared metadata mutation');
      }
      check(Number.isSafeInteger(state.turn) && state.turn >= previous.turn, 'Shared turn cannot regress');
    } else {
      check(Object.keys(state).every(key => ['schemaVersion', 'updated', 'turn', 'mode', 'subSquads',
        'activeSubSquads', 'openEscalations', 'currentRun', 'notify'].includes(key)) &&
        state.schemaVersion === '1.3' && Number.isSafeInteger(state.turn) && state.turn >= 0 &&
        (!state.openEscalations || state.openEscalations.length === 0) &&
        (!state.notify || state.notify.enabled === false),
      'Unapproved bootstrap metadata/trigger/escalations');
      if (state.currentRun) {
        check(Object.keys(state.currentRun.modelOverrides || {}).length === 0 &&
          state.currentRun.estCostUsd === 0 && state.currentRun.estCreditsTotal === 0 &&
          (!state.currentRun.costPreflight || state.currentRun.costPreflight.decision === 'not-requested'),
        'Bootstrap cannot rewrite aggregate run policy or claim prior spend');
      }
    }
  } else check(!base.has(root + 'state.json'), 'Existing shared state was removed');
  for (const [filename, previous] of base) {
    if (filename.startsWith(root + 'members/') && !filename.startsWith(`${root}members/${request.subSquad}/`) ||
      filename.startsWith(root + 'history/') && filename !== `${root}history/${request.subSquad}.md` ||
      filename === root + 'consumption-rates.md' || filename === root + 'consumption.md') {
      check(stagedPaths.includes(filename) && git(['show', `:${filename}`]).equals(previous),
        'Unrelated audit/rate metadata was changed');
    }
    if (filename === root + 'decisions.md' || filename === `${root}history/${request.subSquad}.md` ||
      filename.startsWith(`${root}members/${request.subSquad}/history/`) ||
      filename === `${root}members/${request.subSquad}/decisions.md`) {
      check(stagedPaths.includes(filename) && git(['show', `:${filename}`]).subarray(0, previous.length).equals(previous),
        'Append-only trusted audit was rewritten');
    }
  }
}

function audit(request) {
  // Reconstruct from the exact Git tree, never from model-supplied snapshots.
  sharedAudit(request, baseAudit(request));
  const root = `.copilot-tracking/squad/members/${request.subSquad}/`;
  const state = JSON.parse(readStaged(root + 'state.json'));
  check(state.schemaVersion === '1.4', 'Missing current HVE member-state schema');
  check(state.trigger && state.trigger.ref === request.ref && state.trigger.eventId === request.eventId &&
    state.trigger.source === request.source && state.trigger.actor === request.actor &&
    (!Object.hasOwn(state.trigger, 'sub') || state.trigger.sub === request.subSquad),
  'Missing/mismatched Watch trigger provenance');
  const run = state.trigger.runId;
  check(typeof run === 'string' && /^autopilot-run-[A-Za-z0-9_-]+$/.test(run), 'Missing autopilot audit run ID');
  for (const filename of ['team.md', 'consumption.md', `history/${run}.md`]) {
    check(readStaged(root + filename).trim(), 'Missing required event audit artifact');
  }
  check(readStaged(`.copilot-tracking/squad/history/${request.subSquad}.md`).trim(), 'Missing federation bootstrap history');
  const history = git(['ls-files', '-z', '--', root + 'history/']).toString('utf8').split('\0').filter(Boolean);
  check(history.some(file => file !== `${root}history/${run}.md` && file.endsWith('.md')), 'Missing per-role dispatch history');
  const decisions = readStaged(root + 'decisions.md');
  const match = [...decisions.matchAll(/^#{1,6}\s+Blocking findings[^\S\n]*$/gmi)].at(-1);
  check(match, 'decisions.md must contain Blocking findings (write None if empty)');
  const findings = decisions.slice(match.index + match[0].length).split(/\n#{1,6}\s/)[0].trim();
  check(findings && findings.length <= 12000, 'Blocking findings must be explicit and bounded');
  const pipeline = require('./pipeline.cjs').validate(request, filename => {
    safePath(root + filename, config(), request.subSquad);
    return readStaged(root + filename);
  });
  check(pipeline.status !== 'blocked' || findings.toLowerCase() !== 'none',
    'Blocked RPI requires explicit Blocking findings');
  return { root, run, history, findings, pipeline };
}

function regularFile(filename, maxBytes) {
  const stat = fs.lstatSync(filename);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, 'Invalid or oversized artifact file');
  return fs.readFileSync(filename);
}

function escapeMarkdown(value) {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, c => c === '\n' ? '\n' : ' ')
    .replace(/[\\`*_{}\[\]()#+.!|>@<&]/g, c => `\\${c}`);
}

module.exports = { check, config, integer, credits, watchAuditContract, digest, issueHash, authorized, validIssue,
  branchExists, attempt, requestBytes, execution, revalidateCurrent, git, text, safePath, sanitized,
  auditTargets, workingFile, proposalPaths, stageProposal,
  changes, readStaged, baseAudit, memberBase, audit, regularFile, escapeMarkdown };
