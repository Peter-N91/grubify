'use strict';

const fs = require('node:fs');
const p = require('./policy.cjs');

function verifyInputs(cfg, manifest, lock) {
  // These are reviewed, fixed YAML inputs, not attacker-controlled YAML to parse.
  // Canonicalize Git's Windows/Linux text checkout line endings only.
  const canonical = bytes => Buffer.from(p.text(bytes).replace(/\r\n/g, '\n'), 'utf8');
  p.check(p.digest(canonical(manifest)) === cfg.upstream.approvedManifestLfSha256,
    'APM manifest differs from the reviewed HVE v0.18.1 input; review/update the approval digest');
  p.check(p.digest(canonical(lock)) === cfg.upstream.approvedLockLfSha256,
    'APM lock differs from the reviewed 315-dependency graph; review/update the approval digest');
}

if (require.main === module) {
  const cfg = p.config();
  verifyInputs(cfg, fs.readFileSync('apm.yml'), fs.readFileSync('apm.lock.yaml'));
  console.log(`Verified approved manifest and ${cfg.upstream.approvedDependencyCount}-dependency HVE v0.18.1 lock.`);
}

module.exports = { verifyInputs };
