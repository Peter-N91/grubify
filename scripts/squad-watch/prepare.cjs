'use strict';

const fs = require('node:fs');
const path = require('node:path');
const p = require('./policy.cjs');

module.exports = async function prepare({ github, context, core }) {
  const cfg = p.config();
  p.attempt(process.env.GITHUB_RUN_ATTEMPT);
  p.integer(context.runId, 'run ID');
  core.setOutput('authorized', 'false');
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  p.check(repository === cfg.repository && context.ref === `refs/heads/${cfg.defaultBranch}`,
    'Watch Mode only runs in the reviewed repository on main');
  const manual = context.eventName === 'workflow_dispatch';
  p.check(manual || (context.eventName === 'issues' && context.payload.action === 'labeled' &&
    context.payload.label?.name === cfg.issueLabel), 'Unsupported trigger');
  const actors = [context.actor, process.env.TRIGGERING_ACTOR];
  if (!await p.authorized(github, context.repo, actors)) {
    core.warning('Watch Mode ignored an unauthorized initial/rerun actor (no issue comment).');
    return;
  }
  const number = p.integer(manual ? context.payload.inputs?.issue_number : context.payload.issue?.number, 'issue number');
  const cap = p.credits(manual ? context.payload.inputs?.max_ai_credits : '', cfg);
  const { data: repo } = await github.rest.repos.get(context.repo);
  p.check(repo.default_branch === cfg.defaultBranch, 'Default branch changed; review Watch configuration');
  const { data: branch } = await github.rest.repos.getBranch({ ...context.repo, branch: cfg.defaultBranch });
  p.check(/^[0-9a-f]{40}$/.test(context.sha) && branch.commit.sha === context.sha,
    'Stale or non-main workflow revision; retrigger from current main');
  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  p.validIssue(issue, cfg, !manual);
  p.check(issue.number === number && Number.isSafeInteger(issue.id), 'Invalid issue identity');
  p.check(Buffer.byteLength(issue.title + (issue.body || '')) <= 100000, 'Issue data exceeds input bound');
  p.sanitized(issue.title + '\n' + (issue.body || ''));
  const workingBranch = `squad/issue-${number}`;
  const { data: pulls } = await github.rest.pulls.list({
    ...context.repo, state: 'all', head: `${context.repo.owner}:${workingBranch}`, per_page: 1
  });
  if (pulls.length || await p.branchExists(github, context.repo, workingBranch)) {
    core.warning('Existing event branch/PR: no duplicate AI work or updates. Human recovery/review is required.');
    return;
  }
  const request = {
    schemaVersion: 1,
    repository,
    baseBranch: cfg.defaultBranch,
    baseSha: context.sha,
    issue: number,
    ref: `${repository}#${number}`,
    source: manual ? 'workflow_dispatch' : 'issue',
    // The underlying issue is one unit of work across label/manual retriggers.
    eventId: `issues:${issue.id}`,
    actor: context.actor,
    triggeringActor: process.env.TRIGGERING_ACTOR,
    runId: String(context.runId),
    runAttempt: String(process.env.GITHUB_RUN_ATTEMPT),
    subSquad: `issue-${number}`,
    branch: workingBranch,
    issueHash: p.issueHash(issue),
    model: cfg.model,
    maxAiCredits: cap,
    issueData: { number, title: issue.title, body: issue.body || '' }
  };
  fs.mkdirSync(process.env.REQUEST_DIR, { recursive: true });
  const bytes = JSON.stringify(request, null, 2) + '\n';
  fs.writeFileSync(path.join(process.env.REQUEST_DIR, 'request.json'), bytes);
  core.setOutput('request_sha256', p.digest(bytes));
  core.setOutput('producer_attempt', request.runAttempt);
  core.setOutput('artifact_name', `squad-request-${request.runId}-${request.runAttempt}`);
  core.setOutput('issue', String(number));
  core.setOutput('base_sha', context.sha);
  core.setOutput('authorized', 'true');
  core.info(`Authorized Watch request for issue #${number}; main snapshot and public issue data recorded.`);
};

module.exports.revalidate = async function revalidate(api) {
  const { request } = await p.revalidateCurrent(api);
  p.check(p.git(['rev-parse', 'HEAD']).toString().trim() === request.baseSha,
    'Interpret checkout must be the exact trusted base');
  p.memberBase(request, p.baseAudit(request));
};
