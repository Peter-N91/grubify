'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { gitEnvironment, install } = require('./install-apm.cjs');
const { verifyInputs } = require('./check-apm.cjs');
const p = require('./policy.cjs');
const root = process.cwd();
const directory = path.join(root, '.watch-validation', 'apm-contracts');
const cfg = p.config();
const manifest = fs.readFileSync('apm.yml');
const lock = fs.readFileSync('apm.lock.yaml');
let passed = 0;
function test(action) { action(); passed++; }
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
    assert.deepEqual(calls, [['--version'], ['install', '--frozen', '--target', 'copilot'], ['audit', '--ci']]);
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
  });
  console.log(`Passed ${passed} offline APM portability/integrity contracts. No downloads, AI or remote writes.`);
} finally {
  process.chdir(root);
  fs.rmSync(directory, { recursive: true, force: true });
}
