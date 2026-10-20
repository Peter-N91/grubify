'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyInputs } = require('./check-apm.cjs');
const p = require('./policy.cjs');

function gitEnvironment(env = process.env) {
  // Public dependency acquisition must not inherit platform checkout defaults
  // or credential helpers. APM preserves this process-scoped config path.
  const scoped = { ...env, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(__dirname, 'apm.gitconfig') };
  for (const key of Object.keys(scoped)) {
    if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete scoped[key];
  }
  return scoped;
}

function install(apm, run = execFileSync) {
  const cfg = p.config();
  const inputs = ['apm.yml', 'apm.lock.yaml'].map(file => fs.readFileSync(file));
  verifyInputs(cfg, ...inputs);
  const controlFiles = ['.github/squad-watch.json', path.join(__dirname, 'apm-collision-plan.json')];
  const controls = controlFiles.map(file => fs.readFileSync(file));
  function unchanged() {
    ['apm.yml', 'apm.lock.yaml'].forEach((file, index) =>
      p.check(inputs[index].equals(fs.readFileSync(file)), `APM rewrote ${file}; refusing runtime`));
    controlFiles.forEach((file, index) =>
      p.check(controls[index].equals(fs.readFileSync(file)), 'APM acquisition configuration changed; refusing runtime'));
  }
  const options = { env: gitEnvironment(), stdio: 'inherit' };
  const version = run(apm, ['--version'], { ...options, stdio: 'pipe' }).toString();
  p.check(new RegExp(`CLI version ${cfg.upstream.apmVersion.replace(/\./g, '\\.')}\\b`).test(version),
    'Use the approved APM CLI version');
  run(process.execPath, [path.join(__dirname, 'prewarm-apm.cjs')], { ...options, timeout: 480000 });
  unchanged();
  run(apm, ['install', '--frozen', '--target', 'copilot'], options);
  unchanged();
  run(apm, ['audit', '--ci'], options);
  unchanged();
  for (const file of ['.github/agents/squad-federation-coordinator.agent.md',
    '.agents/skills/squad/SKILL.md']) {
    p.check(fs.statSync(file).size > 0, `Missing installed Squad asset: ${file}`);
  }
}

if (require.main === module) {
  p.check(process.argv.length === 3, 'Usage: node scripts/squad-watch/install-apm.cjs <APM executable>');
  install(process.argv[2]);
}

module.exports = { gitEnvironment, install };
