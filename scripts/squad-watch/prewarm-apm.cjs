'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyInputs } = require('./check-apm.cjs');

const PLAN = path.join(__dirname, 'apm-collision-plan.json');
const REPOS = {
  'microsoft/hve-core': '18f5ac75a1556e49f1e90647a4816d17499e1d7f',
  'Peter-N91/hve-squad': '4c1f140f12f17abd3f200baa3afcb6d4c84bb6da'
};
const TARGETS = [
  'microsoft/hve-core-experiment-designer', 'microsoft/hve-core-git-merge',
  'microsoft/hve-core-pptx', 'microsoft/hve-core-sssc-planner',
  'Peter-N91/hve-squad-squad-document', 'Peter-N91/hve-squad-squad-federation',
  'Peter-N91/hve-squad-squad-governance-report', 'Peter-N91/hve-squad-squad-learn'
];
const EXTENSIONS = { '.agent.md': 'agents', '.instructions.md': 'instructions', '.prompt.md': 'prompts' };
const MAX_BLOB = 262144;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => crypto.createHash('sha1')
  .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const lfHash = bytes => sha256(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')));

class PrewarmError extends Error {}
function check(value, message) { if (!value) throw new PrewarmError(message); }
function safePath(name) {
  check(typeof name === 'string' && name.length <= 240 && name.split('/').every(part =>
    /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..', '.git', '__pycache__'].includes(part) &&
    !/[.]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)),
  'Unsafe acquisition path');
}
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function regular(file, limit) {
  const info = stat(file);
  check(info && info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= limit,
    'Acquisition requires bounded regular files without links');
  return fs.readFileSync(file);
}
function safeDirectories(root, relative) {
  let current = root;
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    current = path.join(current, part);
    const info = stat(current);
    check(!info || (info.isDirectory() && !info.isSymbolicLink()),
      'Unsafe package directory; use a fresh owned checkout/cache');
  }
}
function validatePlan(cfg, plan, bytes) {
  check(lfHash(bytes) === cfg.upstream.approvedCollisionPlanLfSha256,
    'Acquisition plan differs from its reviewed digest');
  check(plan.schemaVersion === 1 && plan.apmVersion === '0.29.0' &&
    plan.apmVersion === cfg.upstream.apmVersion &&
    plan.apmSourceCommit === '5ac6733d55cb4dbe81261491f573e48898c010b6' &&
    plan.approvedDependencyCount === 315 && cfg.upstream.approvedDependencyCount === 315 &&
    plan.approvedManifestLfSha256 === cfg.upstream.approvedManifestLfSha256 &&
    plan.approvedLockLfSha256 === cfg.upstream.approvedLockLfSha256 &&
    cfg.upstream.approvedHveSquadCommit === REPOS['Peter-N91/hve-squad'],
  'Acquisition plan is not bound to the approved APM/root inputs');
  check(Array.isArray(plan.groups) && plan.groups.length === 8, 'Expected eight collision groups');
  const targets = new Set();
  let total = 0;
  for (const group of plan.groups) {
    safePath(group.target);
    check(TARGETS.includes(group.target) && !targets.has(group.target) &&
      Object.hasOwn(REPOS, group.repo) && group.commit === REPOS[group.repo] &&
      group.target.startsWith(`${group.repo}-`) && /^sha256:[a-f0-9]{64}$/.test(group.contentHash),
    'Invalid collision group identity or hash');
    targets.add(group.target);
    check(typeof group.manifest === 'string' && Buffer.byteLength(group.manifest) <= 4096 &&
      !group.manifest.includes('\r') && group.manifest.endsWith('\n'), 'Invalid canonical manifest bytes');
    check(Array.isArray(group.members) &&
      group.members.length === (group.target === 'microsoft/hve-core-pptx' ? 3 : 2),
    'Missing collision member');
    const sources = new Set();
    const destinations = new Set();
    for (const member of group.members) {
      safePath(member.source);
      safePath(member.destination);
      const extension = Object.keys(EXTENSIONS).find(suffix => member.source.endsWith(suffix));
      const filename = member.source.split('/').at(-1);
      check(extension && member.destination === `.apm/${EXTENSIONS[extension]}/${filename}` &&
        group.target === `${group.repo}-${filename.slice(0, -extension.length)}` &&
        member.source.startsWith(group.repo === 'microsoft/hve-core' ? '.github/' : 'squad-src/.github/') &&
        !sources.has(member.source) && !destinations.has(member.destination) &&
        /^[a-f0-9]{40}$/.test(member.gitBlob) && /^[a-f0-9]{64}$/.test(member.sha256) &&
        Number.isSafeInteger(member.bytes) && member.bytes > 0 && member.bytes <= MAX_BLOB,
      'Invalid immutable blob witness or destination');
      sources.add(member.source);
      destinations.add(member.destination);
      total += member.bytes;
    }
  }
  check(total <= 2097152, 'Acquisition exceeds total byte limit');
}
function verifyBlob(bytes, member) {
  check(bytes.length === member.bytes && sha256(bytes) === member.sha256 &&
    gitBlob(bytes) === member.gitBlob,
  'Immutable source blob verification failed; use a fresh owned checkout/cache');
}
function verifyPackage(base, group) {
  safeDirectories(base, '');
  const expected = new Map(group.members.map(member => [member.destination, member]));
  expected.set('apm.yml', null);
  const allowedDirectories = new Set(['.apm', ...group.members.map(member =>
    member.destination.split('/').slice(0, -1).join('/'))]);
  const files = new Map();
  function walk(relative = '') {
    for (const name of fs.readdirSync(path.join(base, relative))) {
      const rel = relative ? `${relative}/${name}` : name;
      const file = path.join(base, rel);
      const info = fs.lstatSync(file);
      check(!info.isSymbolicLink(), 'Linked package content; use a fresh owned checkout/cache');
      if (info.isDirectory()) {
        check(allowedDirectories.has(rel), 'Unknown package directory; use a fresh owned checkout/cache');
        walk(rel);
      } else {
        check(expected.has(rel) || rel === '.apm-pin',
          'Unknown package file; use a fresh owned checkout/cache');
        const bytes = regular(file, rel === '.apm-pin' ? 65536 : MAX_BLOB);
        if (rel === '.apm-pin') continue;
        if (rel === 'apm.yml') check(bytes.equals(Buffer.from(group.manifest)),
          'Canonical package manifest mismatch; use a fresh owned checkout/cache');
        else verifyBlob(bytes, expected.get(rel));
        files.set(rel, bytes);
      }
    }
  }
  walk();
  check(files.size === expected.size, 'Partial package; use a fresh owned checkout/cache');
  // APM 0.29 hashes sorted POSIX paths + raw bytes, without separators.
  // Only its root pin is omitted; nested pins are not excluded by this rule.
  const hash = crypto.createHash('sha256');
  for (const name of [...files.keys()].sort()) hash.update(name).update(files.get(name));
  check(`sha256:${hash.digest('hex')}` === group.contentHash,
    'Approved package aggregate hash mismatch; use a fresh owned checkout/cache');
}
async function acquire(group, member, transport) {
  const url = `https://raw.githubusercontent.com/${group.repo}/${group.commit}/${member.source}`;
  try {
    const response = await transport(url, {
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity',
        'User-Agent': 'grubify-apm-collision-prewarm' }
    });
    check(response.status === 200 && !response.redirected && response.url === url && response.body,
      'Public immutable source HTTP/redirect failure');
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    // Native fetch decodes compression; Content-Length then describes the wire, not the blob.
    check(!encoding || ['identity', 'gzip', 'br', 'deflate'].includes(encoding),
      'Unsupported public immutable source encoding');
    check(length === null || (/^\d+$/.test(length) &&
      (encoding && encoding !== 'identity' ? Number(length) <= MAX_BLOB : Number(length) === member.bytes)),
      'Public immutable source size header mismatch');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      check(size <= member.bytes && size <= MAX_BLOB, 'Public immutable source exceeds byte limit');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    verifyBlob(bytes, member);
    return bytes;
  } catch (error) {
    if (error instanceof PrewarmError) throw error;
    throw new PrewarmError('Public immutable source acquisition failed (network/timeout/redirect)');
  }
}
async function prewarm({ root = process.cwd(), planPath = PLAN, transport = fetch } = {}) {
  root = path.resolve(root);
  const snapshots = new Map([
    [path.join(root, '.github', 'squad-watch.json'), 131072],
    [path.join(root, 'apm.yml'), 16384],
    [path.join(root, 'apm.lock.yaml'), 2097152],
    [planPath, 65536]
  ].map(([file, limit]) => [file, regular(file, limit)]));
  const cfg = JSON.parse(snapshots.get(path.join(root, '.github', 'squad-watch.json')));
  const plan = JSON.parse(snapshots.get(planPath));
  verifyInputs(cfg, snapshots.get(path.join(root, 'apm.yml')), snapshots.get(path.join(root, 'apm.lock.yaml')));
  validatePlan(cfg, plan, snapshots.get(planPath));
  function unchanged() {
    for (const [file, bytes] of snapshots) check(regular(file, bytes.length).equals(bytes),
      'Acquisition inputs changed; refusing package adoption/runtime');
  }
  const modules = path.join(root, 'apm_modules');
  safeDirectories(root, 'apm_modules');
  for (const group of plan.groups) {
    safeDirectories(modules, group.target);
    if (stat(path.join(modules, group.target))) verifyPackage(path.join(modules, group.target), group);
  }
  fs.mkdirSync(modules, { recursive: true });
  const staging = fs.mkdtempSync(path.join(modules, '.apm-collision-stage-'));
  try {
    for (const group of plan.groups) {
      const existing = path.join(modules, group.target);
      if (stat(existing)) continue;
      const base = path.join(staging, group.target);
      for (const member of group.members) {
        const bytes = await acquire(group, member, transport);
        const target = path.join(base, member.destination);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { flag: 'wx' });
      }
      fs.writeFileSync(path.join(base, 'apm.yml'), group.manifest, { flag: 'wx' });
      verifyPackage(base, group);
    }
    unchanged();
    // Validate every image before adopting any, including targets appearing during acquisition.
    for (const group of plan.groups) {
      safeDirectories(modules, group.target);
      const existing = path.join(modules, group.target);
      verifyPackage(stat(existing) ? existing : path.join(staging, group.target), group);
    }
    for (const group of plan.groups) {
      safeDirectories(modules, group.target);
      const destination = path.join(modules, group.target);
      if (stat(destination)) { verifyPackage(destination, group); continue; }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      // Exclusive ownership, not rename-overwrite: even an empty preexisting directory is refused.
      fs.mkdirSync(destination);
      for (const relative of ['apm.yml', ...group.members.map(member => member.destination)]) {
        const file = path.join(destination, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(staging, group.target, relative), file, fs.constants.COPYFILE_EXCL);
      }
      verifyPackage(destination, group);
    }
    unchanged();
    return { groups: plan.groups.length, members: plan.groups.reduce((n, group) => n + group.members.length, 0) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    unchanged();
  }
}

if (require.main === module) {
  Promise.resolve().then(() => {
    check(process.argv.length === 2, 'Usage: node scripts/squad-watch/prewarm-apm.cjs');
    return prewarm();
  }).then(() => console.log('Verified eight approved APM collision images (17 immutable members).'))
    .catch(error => {
      console.error(error instanceof PrewarmError ? error.message :
        'APM collision prewarm failed; use a fresh owned checkout/cache with reviewed inputs');
      process.exitCode = 1;
    });
}

module.exports = { prewarm, validatePlan, verifyPackage, acquire, sha256, gitBlob, lfHash };
