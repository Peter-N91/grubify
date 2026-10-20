'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { gitEnvironment, install } = require('./install-apm.cjs');
const { verifyInputs } = require('./check-apm.cjs');
const { prewarm, validatePlan, acquire, sha256, gitBlob, lfHash } = require('./prewarm-apm.cjs');
const p = require('./policy.cjs');
const root = process.cwd();
const directory = path.join(root, '.watch-validation', 'apm-contracts');
const cfg = p.config();
const manifest = fs.readFileSync('apm.yml');
const lock = fs.readFileSync('apm.lock.yaml');
let passed = 0;
function test(action) { action(); passed++; }
async function asyncTest(action) { await action(); passed++; }
function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function git(args, env = gitEnvironment()) {
  return execFileSync('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
}
function treeHash(base) {
  const files = fs.readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(base, path.join(entry.parentPath || entry.path, entry.name)))
    .filter(file => !file.split(path.sep).includes('.git'))
    .map(file => file.split(path.sep).join('/')).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file).update(fs.readFileSync(path.join(base, file)));
  return hash.digest('hex');
}

async function main() {
fs.mkdirSync(path.dirname(directory), { recursive: true });
fs.mkdirSync(directory, { recursive: false });
try {
  test(() => verifyInputs(cfg, manifest, lock));
  test(() => verifyInputs(cfg,
    Buffer.from(manifest.toString().replace(/\r?\n/g, '\r\n')),
    Buffer.from(lock.toString().replace(/\r?\n/g, '\r\n'))));
  test(() => assert.throws(() => verifyInputs(cfg, manifest, Buffer.concat([lock, Buffer.from('# changed\n')]))));
  test(() => assert.throws(() => verifyInputs(cfg, Buffer.concat([manifest, Buffer.from('\r')]), lock)));
  test(() => {
    const original = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_PARAMETERS: "'core.eol=crlf'", PATH: process.env.PATH };
    const scoped = gitEnvironment(original);
    assert.equal(original.GIT_CONFIG_COUNT, '1');
    assert.equal(scoped.GIT_CONFIG_COUNT, undefined);
    assert.equal(scoped.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(scoped.PATH, original.PATH);
  });

  const source = path.join(directory, 'source');
  git(['init', '--quiet', source]);
  write(path.join(source, '.gitattributes'), 'literal.txt -text\nbinary.dat -text\nbare.txt -text\n');
  write(path.join(source, 'text.txt'), 'upstream LF\nsecond line\n');
  write(path.join(source, 'literal.txt'), 'legitimate upstream CRLF\r\n');
  write(path.join(source, 'binary.dat'), Buffer.from([0, 255, 13, 10, 65]));
  write(path.join(source, 'bare.txt'), 'upstream bare\rcarriage return\n');
  git(['-C', source, 'add', '.']);
  git(['-C', source, '-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Local portability fixture',
    '-m', 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>']);
  const windowsConfig = path.join(directory, 'windows.gitconfig');
  write(windowsConfig, '[core]\n autocrlf = true\n eol = crlf\n');
  const windowsEnv = { ...gitEnvironment(), GIT_CONFIG_GLOBAL: windowsConfig };
  const crlf = path.join(directory, 'crlf');
  const lf = path.join(directory, 'lf');
  git(['clone', '--quiet', source, crlf], windowsEnv);
  git(['clone', '--quiet', source, lf], gitEnvironment(windowsEnv));
  test(() => assert.match(fs.readFileSync(path.join(crlf, 'text.txt'), 'utf8'), /\r\n/));
  test(() => assert.equal(fs.readFileSync(path.join(lf, 'text.txt'), 'utf8'), 'upstream LF\nsecond line\n'));
  test(() => assert.equal(treeHash(lf), treeHash(source)));
  test(() => assert.notEqual(treeHash(crlf), treeHash(source)));
  test(() => assert.equal(fs.readFileSync(path.join(lf, 'literal.txt'), 'utf8'), 'legitimate upstream CRLF\r\n'));
  test(() => assert.deepEqual(fs.readFileSync(path.join(lf, 'binary.dat')), Buffer.from([0, 255, 13, 10, 65])));
  test(() => assert.equal(fs.readFileSync(path.join(lf, 'bare.txt'), 'utf8'), 'upstream bare\rcarriage return\n'));
  test(() => {
    const expected = treeHash(lf);
    fs.appendFileSync(path.join(lf, 'text.txt'), 'tamper\n');
    assert.notEqual(treeHash(lf), expected);
    assert.match(fs.readFileSync(path.join(crlf, 'text.txt'), 'utf8'), /\r\n/,
      'Existing CRLF cache must not be silently rewritten');
  });
  test(() => assert.equal(fs.readFileSync(windowsConfig, 'utf8'), '[core]\n autocrlf = true\n eol = crlf\n'));

  const runtime = path.join(directory, 'runtime');
  write(path.join(runtime, '.github', 'squad-watch.json'), JSON.stringify(cfg));
  write(path.join(runtime, 'apm.yml'), manifest);
  write(path.join(runtime, 'apm.lock.yaml'), lock);
  write(path.join(runtime, '.github', 'agents', 'squad-federation-coordinator.agent.md'), 'fixture\n');
  write(path.join(runtime, '.agents', 'skills', 'squad', 'SKILL.md'), 'fixture\n');
  process.chdir(runtime);
  let calls;
  const runner = (file, args, options) => {
    calls.push(args);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, gitEnvironment().GIT_CONFIG_GLOBAL);
    if (args[0] === '--version') return Buffer.from('Agent Package Manager (APM) CLI version 0.29.0 (5ac6733)');
    return Buffer.alloc(0);
  };
  test(() => {
    calls = [];
    install('fixture-apm', runner);
    assert.deepEqual(calls, [['--version'], [path.join(__dirname, 'prewarm-apm.cjs')],
      ['install', '--frozen', '--target', 'copilot'], ['audit', '--ci']]);
  });
  test(() => {
    calls = [];
    assert.throws(() => install('fixture-apm', (file, args, options) => {
      if (file === process.execPath) throw new Error('prewarm denied');
      return runner(file, args, options);
    }), /prewarm denied/);
    assert.deepEqual(calls, [['--version']]);
  });
  test(() => {
    calls = [];
    assert.throws(() => install('fixture-apm', (file, args, options) => {
      const result = runner(file, args, options);
      if (file === process.execPath) fs.appendFileSync('apm.yml', '\n');
      return result;
    }), /rewrote apm.yml/);
    assert.equal(calls.some(args => args[0] === 'install' || args[0] === 'audit'), false);
    fs.writeFileSync('apm.yml', manifest);
  });
  test(() => {
    calls = [];
    assert.throws(() => install('fixture-apm', (file, args, options) => {
      const result = runner(file, args, options);
      if (args[0] === 'audit') fs.appendFileSync('apm.lock.yaml', '\n');
      return result;
    }), /rewrote apm.lock.yaml/);
    fs.writeFileSync('apm.lock.yaml', lock);
  });
  test(() => {
    calls = [];
    assert.throws(() => install('fixture-apm', (file, args, options) => {
      const result = runner(file, args, options);
      if (args[0] === 'install') fs.appendFileSync('apm.lock.yaml', '\n');
      return result;
    }), /rewrote apm.lock.yaml/);
    assert.equal(calls.some(args => args[0] === 'audit'), false);
    fs.writeFileSync('apm.lock.yaml', lock);
  });
  test(() => assert.throws(() => install('fixture-apm', (file, args) => {
    if (args[0] === '--version') return Buffer.from('CLI version 0.29.1');
    assert.fail('Wrong version must not install');
  }), /approved APM CLI version/));
  test(() => {
    calls = [];
    assert.throws(() => install('fixture-apm', (file, args, options) => {
      const result = runner(file, args, options);
      if (args[0] === 'install') fs.appendFileSync('apm.yml', '\n');
      return result;
    }), /rewrote apm.yml/);
    assert.equal(calls.some(args => args[0] === 'audit'), false);
    fs.writeFileSync('apm.yml', manifest);
  });
  test(() => {
    calls = [];
    assert.throws(() => install('fixture-apm', (file, args, options) => {
      if (args[0] === 'install') throw new Error('package content hash mismatch');
      return runner(file, args, options);
    }), /hash mismatch/);
    assert.equal(calls.some(args => args[0] === 'audit'), false);
  });
  test(() => {
    calls = [];
    assert.throws(() => install('fixture-apm', (file, args, options) => {
      if (args[0] === 'audit') throw new Error('audit denied');
      return runner(file, args, options);
    }), /audit denied/);
  });
  test(() => {
    fs.appendFileSync('apm.yml', '# unapproved\n');
    assert.throws(() => install('fixture-apm', () => assert.fail('Must reject before executing APM')),
      /manifest differs/);
    fs.writeFileSync('apm.yml', manifest);
  });
  process.chdir(root);
  const reviewed = JSON.parse(fs.readFileSync(path.join(__dirname, 'apm-collision-plan.json')));
  test(() => validatePlan(cfg, reviewed, fs.readFileSync(path.join(__dirname, 'apm-collision-plan.json'))));
  const rows = lock.toString().replace(/\r\n/g, '\n').split('\n- repo_url: ');
  for (const group of reviewed.groups) {
    for (const member of group.members) test(() => {
      const matches = rows.filter(row => row.includes(`\n  virtual_path: ${member.source}\n`) &&
        row.includes(`\n  name: ${group.target.split('/')[1]}\n`));
      assert.equal(matches.length, 1);
      assert.ok(matches[0].includes(`\n  resolved_commit: ${group.commit}\n`));
      assert.ok(matches[0].split('\n').includes(`  content_hash: ${group.contentHash}`));
      assert.ok(matches[0].startsWith(`${group.repo.toLowerCase()}\n`));
      if (group.repo.startsWith('Peter-N91/')) {
        assert.ok(matches[0].includes(`\n  materialization_repo_url: ${group.repo}\n`));
      }
    });
  }
  let fixtureNumber = 0;
  function fixture() {
    const base = path.join(directory, `collision-${fixtureNumber++}`);
    const plan = structuredClone(reviewed);
    const data = new Map();
    for (const group of plan.groups) {
      const image = new Map([['apm.yml', Buffer.from(group.manifest)]]);
      for (const member of group.members) {
        const bytes = Buffer.from(`raw fixture: ${member.source}\r\nunmodified\rbytes\n`);
        data.set(member.source, bytes);
        Object.assign(member, { bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
        image.set(member.destination, bytes);
      }
      const hash = crypto.createHash('sha256');
      for (const name of [...image.keys()].sort()) hash.update(name).update(image.get(name));
      group.contentHash = `sha256:${hash.digest('hex')}`;
    }
    const planPath = path.join(base, 'plan.json');
    const config = structuredClone(cfg);
    function save() {
      const bytes = Buffer.from(JSON.stringify(plan));
      config.upstream.approvedCollisionPlanLfSha256 = lfHash(bytes);
      write(planPath, bytes);
      write(path.join(base, '.github', 'squad-watch.json'), JSON.stringify(config));
    }
    write(path.join(base, 'apm.yml'), manifest);
    write(path.join(base, 'apm.lock.yaml'), lock);
    save();
    const requests = [];
    const transport = async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(Object.keys(options.headers).some(key => /authorization|token|cookie/i.test(key)), false);
      const group = plan.groups.find(g => url.startsWith(`https://raw.githubusercontent.com/${g.repo}/${g.commit}/`));
      assert.ok(group, 'Only allowlisted public immutable URLs');
      const source = url.slice(`https://raw.githubusercontent.com/${group.repo}/${group.commit}/`.length);
      const response = new Response(data.get(source), { status: 200 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    const options = { root: base, planPath, transport };
    function seed(group = plan.groups[0]) {
      const destination = path.join(base, 'apm_modules', group.target);
      write(path.join(destination, 'apm.yml'), group.manifest);
      for (const member of group.members) write(path.join(destination, member.destination), data.get(member.source));
      return destination;
    }
    function noAdoptions() {
      for (const group of plan.groups) assert.equal(fs.existsSync(path.join(base, 'apm_modules', group.target)), false);
      const modules = path.join(base, 'apm_modules');
      if (fs.existsSync(modules)) assert.equal(fs.readdirSync(modules).some(n => n.startsWith('.apm-collision-stage-')), false);
    }
    return { base, plan, planPath, config, data, requests, transport, options, seed, save, noAdoptions };
  }
  await asyncTest(async () => {
    const f = fixture();
    assert.deepEqual(await prewarm(f.options), { groups: 8, members: 17 });
    assert.equal(f.requests.length, 17);
    assert.deepEqual(fs.readFileSync(path.join(f.base, 'apm.yml')), manifest);
    assert.deepEqual(fs.readFileSync(path.join(f.base, 'apm.lock.yaml')), lock);
    await prewarm({ ...f.options, transport: () => assert.fail('Exact reuse must not download') });
    assert.equal(fs.readdirSync(path.join(f.base, 'apm_modules')).length, 2);
  });
  await asyncTest(async () => {
    const f = fixture();
    f.plan.groups.reverse();
    for (const group of f.plan.groups) group.members.reverse();
    f.save();
    await prewarm(f.options);
    assert.equal(f.requests.length, 17);
  });
  const invalidPlans = [
    f => { f.plan.apmVersion = '0.29.1'; },
    f => { f.plan.apmSourceCommit = '0'.repeat(40); },
    f => { f.plan.approvedManifestLfSha256 = '0'.repeat(64); },
    f => { f.plan.approvedLockLfSha256 = '0'.repeat(64); },
    f => { f.plan.groups.pop(); },
    f => { f.plan.groups[0].members.pop(); },
    f => { f.plan.groups[0].members[1] = f.plan.groups[0].members[0]; },
    f => { f.plan.groups[0].repo = 'unknown/repo'; },
    f => { f.plan.groups[0].commit = '0'.repeat(40); },
    f => { f.plan.groups[0].target = '../outside'; },
    f => { f.plan.groups[0].members[0].source = '.github/../../escape.agent.md'; },
    f => { f.plan.groups[0].members[0].source = '.github/%2e%2e/escape.agent.md'; },
    f => { f.plan.groups[0].members[0].destination = '.apm\\agents\\escape.agent.md'; },
    f => { f.plan.groups[0].members[0].bytes = 262145; }
  ];
  for (const mutate of invalidPlans) await asyncTest(async () => {
    const f = fixture();
    mutate(f);
    f.save();
    await assert.rejects(prewarm(f.options));
    assert.equal(f.requests.length, 0);
    f.noAdoptions();
  });
  await asyncTest(async () => {
    const f = fixture();
    fs.appendFileSync(f.planPath, '\n');
    await assert.rejects(prewarm(f.options), /reviewed digest/);
    f.noAdoptions();
  });
  for (const name of ['apm.yml', 'apm.lock.yaml']) await asyncTest(async () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.base, name), '# changed\n');
    await assert.rejects(prewarm(f.options), /differs/);
    assert.equal(f.requests.length, 0);
    f.noAdoptions();
  });
  for (const mutation of ['gitBlob', 'sha256', 'manifest', 'contentHash', 'bytes']) await asyncTest(async () => {
    const f = fixture();
    const last = f.plan.groups.at(-1);
    if (mutation === 'manifest') last.manifest += '# wrong\n';
    else if (mutation === 'contentHash') last.contentHash = `sha256:${'0'.repeat(64)}`;
    else if (mutation === 'bytes') last.members.at(-1).bytes++;
    else last.members.at(-1)[mutation] = '0'.repeat(mutation === 'gitBlob' ? 40 : 64);
    f.save();
    await assert.rejects(prewarm(f.options));
    f.noAdoptions();
  });
  await asyncTest(async () => {
    const f = fixture();
    const member = f.plan.groups.at(-1).members.at(-1);
    f.data.set(member.source, Buffer.alloc(member.bytes, 65));
    await assert.rejects(prewarm(f.options), /verification failed/);
    f.noAdoptions();
  });
  for (const corrupt of ['partial', 'extra', 'nested-pin', 'empty-directory', 'manifest', 'changed']) {
    await asyncTest(async () => {
      const f = fixture();
      const base = f.seed();
      if (corrupt === 'partial') fs.unlinkSync(path.join(base, f.plan.groups[0].members[0].destination));
      if (corrupt === 'extra') write(path.join(base, 'unknown.txt'), 'untouched');
      if (corrupt === 'nested-pin') write(path.join(base, '.apm', '.apm-pin'), 'untouched');
      if (corrupt === 'empty-directory') fs.mkdirSync(path.join(base, 'extra'));
      if (corrupt === 'manifest') fs.appendFileSync(path.join(base, 'apm.yml'), '# bad\n');
      if (corrupt === 'changed') fs.appendFileSync(path.join(base, f.plan.groups[0].members[0].destination), 'bad');
      const before = treeHash(base);
      await assert.rejects(prewarm(f.options));
      assert.equal(treeHash(base), before);
      assert.equal(f.requests.length, 0);
    });
  }
  await asyncTest(async () => {
    const f = fixture();
    const base = f.seed();
    write(path.join(base, '.apm-pin'), 'existing root pin\n');
    await prewarm(f.options);
    assert.equal(fs.readFileSync(path.join(base, '.apm-pin'), 'utf8'), 'existing root pin\n');
    assert.equal(f.requests.length, 15);
  });
  for (const relative of ['apm_modules', 'apm_modules/microsoft',
    `apm_modules/${reviewed.groups[0].target}`]) await asyncTest(async () => {
    const f = fixture();
    const link = path.join(f.base, relative);
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prewarm(f.options), /Unsafe package directory/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
  await asyncTest(async () => {
    const f = fixture();
    const base = f.seed();
    const link = path.join(base, f.plan.groups[0].members[0].destination);
    fs.unlinkSync(link);
    fs.symlinkSync(f.base, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prewarm(f.options), /Linked package content/);
  });
  for (const input of ['apm.yml', 'apm.lock.yaml', 'plan.json', '.github/squad-watch.json']) {
    await asyncTest(async () => {
      const f = fixture();
      let changed = false;
      const transport = async (...args) => {
        if (!changed) { fs.appendFileSync(path.join(f.base, input), '\n'); changed = true; }
        return f.transport(...args);
      };
      await assert.rejects(prewarm({ ...f.options, transport }), /inputs changed|bounded regular/);
      f.noAdoptions();
    });
  }
  await asyncTest(async () => {
    const f = fixture();
    const transport = async (...args) => {
      if (!f.requests.length) {
        write(path.join(f.base, 'apm_modules', f.plan.groups.at(-1).target, 'partial'), 'do not overwrite');
      }
      return f.transport(...args);
    };
    await assert.rejects(prewarm({ ...f.options, transport }));
    assert.equal(fs.existsSync(path.join(f.base, 'apm_modules', f.plan.groups[0].target)), false);
    assert.equal(fs.readFileSync(path.join(f.base, 'apm_modules', f.plan.groups.at(-1).target, 'partial'), 'utf8'),
      'do not overwrite');
  });
  const f = fixture();
  const group = f.plan.groups[0];
  const member = group.members[0];
  for (const failure of ['redirect', 'http', 'oversize-header', 'oversize-body', 'short-body',
    'network', 'timeout', 'encoding']) await asyncTest(async () => {
    const transport = async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      if (failure === 'network' || failure === 'timeout') throw new Error('private response/token text');
      const bytes = failure === 'oversize-body' ? Buffer.alloc(member.bytes + 1) :
        failure === 'short-body' ? Buffer.alloc(member.bytes - 1) : f.data.get(member.source);
      const response = new Response(bytes, { status: failure === 'http' ? 503 : 200,
        headers: failure === 'oversize-header' ? { 'content-length': `${member.bytes + 1}` } :
          failure === 'encoding' ? { 'content-encoding': 'unknown' } : {} });
      Object.defineProperty(response, 'url', { value: failure === 'redirect' ? 'https://example.invalid/' : url });
      return response;
    };
    await assert.rejects(acquire(group, member, transport), error =>
      !error.message.includes('private') && /source|blob/.test(error.message));
  });
  await asyncTest(async () => {
    const transport = async (url, options) => {
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      const response = new Response(f.data.get(member.source), {
        headers: { 'content-encoding': 'gzip', 'content-length': '20' }
      });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
    assert.deepEqual(await acquire(group, member, transport), f.data.get(member.source));
  });
  console.log(`Passed ${passed} offline APM portability/integrity contracts. No downloads, AI or remote writes.`);
} finally {
  process.chdir(root);
  fs.rmSync(directory, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
