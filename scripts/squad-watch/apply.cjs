'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('./policy.cjs');

function validateArtifact(request, cfg, directory) {
  p.check(fs.readdirSync(directory).sort().join(',') === 'handoff.json,squad-watch.patch',
    'Artifact must contain only the manifest and patch');
  const manifest = JSON.parse(p.text(p.regularFile(path.join(directory, 'handoff.json'), 100000)));
  const patchPath = path.join(directory, 'squad-watch.patch');
  const patch = p.regularFile(patchPath, cfg.maximumPatchBytes);
  const origin = p.execution(request);
  const producer = p.attempt(process.env.EXPECTED_HANDOFF_ATTEMPT, 'handoff producer attempt');
  p.integer(process.env.EXPECTED_HANDOFF_ARTIFACT_ID, 'handoff artifact ID');
  p.check(producer >= p.attempt(request.runAttempt) && producer <= p.attempt(origin.runAttempt) &&
    process.env.EXPECTED_HANDOFF_ARTIFACT === `squad-handoff-${request.runId}-${producer}` &&
    p.attempt(manifest.runAttempt, 'manifest producer attempt') === producer &&
    manifest.requestRunAttempt === request.runAttempt &&
    manifest.runId === request.runId && manifest.requestSha256 === origin.requestSha256 &&
    manifest.requestArtifact === origin.requestArtifact &&
    manifest.requestArtifactId === origin.requestArtifactId && typeof manifest.triggeringActor === 'string' &&
    manifest.triggeringActor.length > 0, 'Handoff producer provenance mismatch');
  p.check(manifest.schemaVersion === 1 && manifest.baseSha === request.baseSha &&
    manifest.issue === request.issue && manifest.subSquad === request.subSquad &&
    p.creditInput(manifest, cfg) === p.creditInput(request, cfg) &&
    manifest.patchSha256 === p.digest(patch), 'Artifact contract/integrity mismatch');
  p.check(Array.isArray(manifest.files) && manifest.files.length <= cfg.maximumFiles, 'Invalid manifest paths');
  p.check(p.git(['rev-parse', 'HEAD']).toString().trim() === request.baseSha &&
    !p.git(['status', '--porcelain']).toString().trim(), 'Apply checkout must be a clean, exact base');
  if (manifest.status === 'no-change') {
    p.check(patch.length === 0 && manifest.files.length === 0, 'Invalid no-change artifact');
    const audit = p.audit(request);
    require('./pipeline.cjs').validateDispatch(manifest.dispatch, request, audit.pipeline, manifest.runAttempt);
    return { changes: [], audit };
  }
  p.check(manifest.status === 'changed' && patch.length > 0, 'Invalid artifact status');
  p.sanitized(p.text(patch));
  // git apply itself does not run code. Inspect both its path report and the
  // resulting index; no model-chosen path ever reaches the GitHub write API.
  const stats = p.git(['apply', '--numstat', '-z', patchPath]).toString('utf8').split('\0').filter(Boolean);
  p.check(stats.length > 0 && stats.length <= cfg.maximumFiles, 'Invalid patch path count');
  for (const stat of stats) {
    const match = /^(\d+)\t(\d+)\t(.+)$/.exec(stat);
    p.check(match, 'Binary, rename or malformed patch denied');
    p.safePath(match[3], cfg, request.subSquad);
  }
  p.git(['apply', '--check', '--index', patchPath]);
  p.git(['apply', '--index', patchPath]);
  const changes = p.changes(cfg, request.subSquad);
  const actual = changes.map(({ path: filename, status, mode, bytes }) =>
    ({ path: filename, status, mode, sha256: bytes === null ? null : p.digest(bytes) }));
  p.check(JSON.stringify(actual) === JSON.stringify(manifest.files), 'Patch/index manifest mismatch');
  p.check(changes.length > 0, 'Empty changed artifact');
  const audit = p.audit(request);
  require('./pipeline.cjs').validateDispatch(manifest.dispatch, request, audit.pipeline, manifest.runAttempt);
  require('./pipeline.cjs').sourceGate(request, audit.pipeline, changes);
  return { changes, audit };
}

function body(request, evidence) {
  return [
    `Closes #${request.issue}`, '',
    'Opened unattended by **Squad Watch**. This is a **DRAFT**, not approval to merge or deploy.',
    'Human review is the final-outcome validation surface. No automatic merge/release/deployment exists.', '',
    'The trusted apply job adds `squad/review` to this draft and explicitly dispatches',
    'a separate pr-N Squad coordinator for size-bounded static source review. Bot-generated',
    'label events alone do not start that workflow. Its report is a comment, never approval.',
    `That second independent session inherits this authorized credit mode/cap: ${p.creditNotice(request)}`, '',
    `RPI pipeline: **${evidence.pipeline.status}**; inspect \`${evidence.root}pipeline.json\`.`,
    'Ordered cast dispatch and serialized Scribe handoffs were checked against runtime lifecycle events.', '',
    `Source: ${request.ref}; actor: ${request.actor}; event: ${request.eventId}.`,
    `Base: \`${request.baseSha}\`; model: \`${request.model}\`.`,
    p.creditNotice(request),
    `Run: https://github.com/${request.repository}/actions/runs/${request.runId}`, '',
    `Event state: \`${evidence.root}state.json\``,
    `Outcome/acceptance/limitations: \`${evidence.root}decisions.md\``,
    `Consumption: \`${evidence.root}consumption.md\``,
    `Autopilot history: \`${evidence.root}history/${evidence.run}.md\``,
    'Per-role history (verify every claimed dispatch):',
    ...evidence.history.map(filename => `- \`${filename}\``), '',
    '## Blocking findings', '',
    // Escape model-authored text before publishing; never interpolate it in a shell.
    p.escapeMarkdown(evidence.findings), '',
    '## Human checklist', '',
    '- [ ] Public issue and all changed files/audit have been sanitized',
    '- [ ] Acceptance criteria and existing tests have been independently verified',
    '- [ ] Every claimed role dispatch has real domain artifacts and a history entry',
    '- [ ] Blocking findings, gaps and cost/credit reporting were reviewed',
    '- [ ] Main protections and human approvals are satisfied before marking ready/merging',
    '- [ ] Any deployment or impactful action is separately approved'
  ].join('\n');
}

module.exports = async function apply({ github, context, core }) {
  const { request, cfg } = await p.revalidateCurrent({ github, context });
  const result = validateArtifact(request, cfg, process.env.HANDOFF_DIR);
  if (!result.changes.length) {
    core.setOutput('status', 'no-change');
    return;
  }
  const prBody = body(request, result.audit);
  // Repeat authorization and stale-input checks immediately before mutation.
  await p.revalidateCurrent({ github, context });
  const { data: commit } = await github.rest.git.getCommit({ ...context.repo, commit_sha: request.baseSha });
  const tree = [];
  for (const file of result.changes) {
    let sha = null;
    if (file.bytes !== null) {
      const { data: blob } = await github.rest.git.createBlob({
        ...context.repo, content: file.bytes.toString('base64'), encoding: 'base64'
      });
      sha = blob.sha;
    }
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha });
  }
  const { data: newTree } = await github.rest.git.createTree({ ...context.repo, base_tree: commit.tree.sha, tree });
  const { data: newCommit } = await github.rest.git.createCommit({
    ...context.repo,
    message: `fix: address #${request.issue} via Squad Watch\n\nRun: ${request.runId}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
    tree: newTree.sha,
    parents: [request.baseSha]
  });
  // CREATE ONLY: API atomically refuses an existing ref. No updateRef or push,
  // no credentials stored in remotes, no hooks, no repo script/code execution.
  await github.rest.git.createRef({ ...context.repo, ref: `refs/heads/${request.branch}`, sha: newCommit.sha });
  const { data: pr } = await github.rest.pulls.create({
    ...context.repo, head: request.branch, base: cfg.defaultBranch, draft: true,
    title: `Squad Watch: address #${request.issue}`, body: prBody, maintainer_can_modify: false
  });
  p.check(pr.draft === true, 'Draft PR creation did not return a draft; human recovery required');
  const link = `https://github.com/${cfg.repository}/pull/${p.integer(pr.number, 'created PR')}`;
  core.info(`Created DRAFT ${link}; labeling/dispatch must still succeed. Never rerun generation to overwrite this PR.`);
  try {
    const { data: labels } = await github.rest.issues.addLabels({ ...context.repo, issue_number: pr.number, labels: [cfg.review.label] });
    p.check(labels.some(label => label.name === cfg.review.label), 'GitHub did not return the required review label');
  } catch {
    throw new Error(`Created DRAFT ${link}, but squad/review labeling failed. Human recovery: verify/add the label and dispatch Squad Review; do not regenerate.`);
  }
  const linkage = {
    schemaVersion: 1, status: 'draft-created', repository: cfg.repository,
    sourceRunId: String(context.runId), sourceAttempt: process.env.GITHUB_RUN_ATTEMPT,
    sourceWorkflow: cfg.review.sourceWorkflow,
    actor: request.actor, requestActor: request.triggeringActor,
    applyActor: process.env.TRIGGERING_ACTOR,
    requestAttempt: request.runAttempt,
    generationSource: request.source,
    generationMaxAiCreditsInput: context.eventName === 'workflow_dispatch'
      ? context.payload.inputs?.max_ai_credits ?? '' : '',
    maxAiCredits: request.maxAiCredits,
    uncappedDiagnostic: request.uncappedDiagnostic,
    issue: request.issue, pr: pr.number, branch: request.branch,
    baseSha: request.baseSha, headSha: newCommit.sha, label: cfg.review.label
  };
  const bytes = JSON.stringify(linkage, null, 2) + '\n';
  fs.mkdirSync(process.env.RESULT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.RESULT_DIR, 'result.json'), bytes);
  core.setOutput('pr', String(pr.number));
  core.setOutput('review_max_ai_credits', p.creditInput(request, cfg));
  core.setOutput('result_sha256', p.digest(bytes));
  core.setOutput('result_artifact', `squad-result-${context.runId}-${process.env.GITHUB_RUN_ATTEMPT}`);
  core.setOutput('status', 'draft-created');
  core.info(`Created draft PR #${pr.number}; human review required.`);
};

module.exports.validateArtifact = validateArtifact;
module.exports.body = body;
