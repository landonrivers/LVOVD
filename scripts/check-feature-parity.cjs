'use strict';

// Development/release validation only. This does not execute media operations.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const ROOT = path.resolve(__dirname, '..');
const REGISTER = 'docs/v3-feature-parity.json';
const GUIDE = 'docs/v3-feature-parity.md';
const BASELINE = '7e192ad7ddee6478b517a74174cedf6dccd85a19';
const PLATFORMS = ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64'];
const STATUSES = ['Missing', 'Ported', 'Integrated', 'Verified'];
const SHA = /^[a-f0-9]{40}$/;
const BEGIN = '<!-- parity-table:start -->';
const END = '<!-- parity-table:end -->';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const repoPath = value => text(value) && /^[a-zA-Z0-9_./-]+$/.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
const testPath = (value, kind) => kind === 'reference' ? /^test\/.+\.(?:test|spec)\.js$/.test(value)
  : kind === 'rust' ? /^crates\/.+\.rs$/.test(value) || /^src-tauri\/.+\.rs$/.test(value)
    : /^(?:desktop\/test\/|test\/native\/).+\.(?:cjs|js|ts|rs)$/.test(value);

function validateRegister(data, { read = file => fs.readFileSync(path.join(ROOT, file), 'utf8'), previous, release = false } = {}) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  function fields(value, names, label) {
    if (!object(value)) { errors.push(`${label}: expected an object`); return false; }
    for (const name of Object.keys(value)) require(names.includes(name), `${label}: unknown field ${name}`);
    for (const name of names) require(Object.hasOwn(value, name), `${label}: missing field ${name}`);
    return true;
  }
  function strings(value, label, minimum = 1) {
    if (!Array.isArray(value)) { errors.push(`${label}: expected a list`); return []; }
    require(value.length >= minimum && value.every(text), `${label}: requires ${minimum} or more nonempty values`);
    require(new Set(value).size === value.length, `${label}: duplicate value`);
    return value.filter(text);
  }
  function files(value, label, minimum = 0, kind) {
    const names = strings(value, label, minimum);
    for (const name of names) {
      if (!repoPath(name)) { errors.push(`${label}: unsafe repository path ${name}`); continue; }
      if (kind) require(testPath(name, kind), `${label}: not a ${kind} test reference: ${name}`);
      try {
        const content = read(name);
        require(text(content), `${label}: empty reference ${name}`);
        if (kind === 'rust') require(/#\[(?:tokio::)?test\]/.test(content), `${label}: no Rust test found in ${name}`);
      } catch { errors.push(`${label}: missing reference ${name}`); }
    }
    return names;
  }
  if (!fields(data, ['schemaVersion', 'baseline', 'platforms', 'accessException', 'capabilities'], 'register')) return errors;
  require(data.schemaVersion === 1, 'register: unsupported schema version');
  if (fields(data.baseline, ['version', 'commit', 'acceptedFixes'], 'baseline')) {
    require(data.baseline.version === '2.7.0' && data.baseline.commit === BASELINE, 'baseline: released v2.7 identity cannot change');
    require(Array.isArray(data.baseline.acceptedFixes), 'baseline: acceptedFixes must be a list');
    for (const fix of Array.isArray(data.baseline.acceptedFixes) ? data.baseline.acceptedFixes : []) {
      if (fields(fix, ['commit', 'capabilities', 'reason', 'approval'], 'accepted fix')) {
        require(SHA.test(fix.commit), 'accepted fix: requires full commit');
        strings(fix.capabilities, 'accepted fix capabilities');
        require(text(fix.reason) && text(fix.approval), 'accepted fix: reason and approval are required');
      }
    }
  }
  require(isDeepStrictEqual(data.platforms, PLATFORMS), 'platforms: all four launch architectures remain required');
  if (fields(data.accessException, ['id', 'behavior', 'approval'], 'access exception')) {
    require(data.accessException.id === 'standalone-access', 'access exception: only standalone-access is approved');
    require(text(data.accessException.behavior) && text(data.accessException.approval), 'access exception: describe the approved replacement');
  }
  if (!Array.isArray(data.capabilities) || !data.capabilities.length) return [...errors, 'capabilities: nonempty inventory required'];
  const ids = new Set();
  for (const c of data.capabilities) {
    if (!fields(c, ['id', 'title', 'origin', 'reference', 'desktop', 'status', 'implementation', 'tests', 'acceptance', 'evidence', 'remaining'], 'capability')) continue;
    const label = String(c.id);
    require(typeof c.id === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(c.id), `${label}: invalid stable ID`);
    require(!ids.has(c.id), `${label}: duplicate stable ID`); ids.add(c.id);
    require(text(c.title), `${label}: title required`);
    require(['baseline', 'desktop'].includes(c.origin), `${label}: invalid origin`);
    require(STATUSES.includes(c.status), `${label}: invalid status (waivers are not statuses)`);
    if (fields(c.reference, ['behavior', 'sources'], `${label} reference`)) {
      require(text(c.reference.behavior), `${label}: reference behavior required`);
      files(c.reference.sources, `${label} sources`, 1);
    }
    if (fields(c.desktop, ['location', 'stage', 'operations'], `${label} desktop`)) {
      require(text(c.desktop.location), `${label}: native location required`);
      require(/^8[B-F]$/.test(c.desktop.stage), `${label}: invalid migration stage`);
      for (const op of strings(c.desktop.operations, `${label} operations`)) require(/^[a-z][a-z0-9_]+$/.test(op), `${label}: invalid planned operation`);
    }
    const rank = STATUSES.indexOf(c.status);
    if (fields(c.implementation, ['rust', 'native'], `${label} implementation`)) {
      for (const file of files(c.implementation.rust, `${label} Rust implementation`, rank >= 1 ? 1 : 0)) require(/^(?:crates|src-tauri)\/.+\.rs$/.test(file), `${label}: implementation must reference Rust source`);
      files(c.implementation.native, `${label} native integration`, rank >= 2 ? 1 : 0);
    }
    if (fields(c.tests, ['reference', 'rust', 'native'], `${label} tests`)) {
      files(c.tests.reference, `${label} reference tests`, c.origin === 'baseline' ? 1 : 0, 'reference');
      files(c.tests.rust, `${label} Rust tests`, rank >= 1 ? 1 : 0, 'rust');
      files(c.tests.native, `${label} native tests`, rank >= 3 ? 1 : 0, 'native');
    }
    strings(c.acceptance, `${label} acceptance`);
    require(typeof c.remaining === 'string' && (c.status === 'Verified' ? c.remaining === '' : text(c.remaining)), `${label}: describe unfinished work; Verified must have none`);
    if (!Array.isArray(c.evidence)) { errors.push(`${label}: evidence must be a list`); continue; }
    const evidencePlatforms = new Set();
    const revisions = new Set();
    for (const e of c.evidence) {
      if (!fields(e, ['platform', 'commit', 'kind', 'result', 'url', 'tests', 'notes'], `${label} evidence`)) continue;
      require(PLATFORMS.includes(e.platform), `${label}: unknown evidence platform`);
      require(!evidencePlatforms.has(e.platform), `${label}: duplicate platform receipt`); evidencePlatforms.add(e.platform);
      require(SHA.test(e.commit), `${label}: evidence requires a full commit`); revisions.add(e.commit);
      require(e.kind === 'native-workflow' && e.result === 'passed', `${label}: evidence must be a passed native workflow, not library/Chromium tests`);
      require(typeof e.url === 'string' && /^https:\/\/github\.com\/landonrivers\/LVOVD\/actions\/runs\/[0-9]+(?:\/job\/[0-9]+)?$/.test(e.url), `${label}: evidence must link a repository CI run/job`);
      for (const file of files(e.tests, `${label} evidence tests`, 1, 'native')) require(c.tests?.native?.includes(file), `${label}: receipt test must be mapped to this capability`);
      require(text(e.notes), `${label}: receipt must explain the exercised workflow`);
    }
    if (rank >= 3) {
      require(PLATFORMS.every(p => evidencePlatforms.has(p)), `${label}: Verified requires all platform receipts`);
      require(revisions.size === 1, `${label}: platform receipts must verify one implementation revision`);
    }
    if (release) require(c.status === 'Verified', `${label}: release blocked (${c.status})`);
  }
  for (const fix of Array.isArray(data.baseline?.acceptedFixes) ? data.baseline.acceptedFixes : []) {
    if (Array.isArray(fix?.capabilities)) for (const id of fix.capabilities) require(ids.has(id), `accepted fix: unknown capability ${id}`);
  }
  if (previous) {
    require(previous.schemaVersion === data.schemaVersion, 'comparison: schema changes require an explicit validator migration');
    require(isDeepStrictEqual(previous.accessException, data.accessException), 'comparison: approved access exception cannot silently change');
    for (const old of previous.capabilities || []) {
      const current = data.capabilities.find(c => c.id === old.id);
      require(Boolean(current), `${old.id}: existing capability cannot be deleted or renamed`);
      if (current) {
        require(current.origin === old.origin, `${old.id}: baseline origin cannot be reclassified`);
        require(isDeepStrictEqual(current.reference, old.reference), `${old.id}: frozen reference cannot change; record an accepted fix addendum`);
      }
    }
    for (const fix of previous.baseline?.acceptedFixes || []) require(data.baseline?.acceptedFixes?.some(f => isDeepStrictEqual(f, fix)), 'comparison: accepted fixes cannot be removed');
  }
  return errors;
}

function renderTable(data) {
  const counts = Object.fromEntries(STATUSES.map(s => [s, data.capabilities.filter(c => c.status === s).length]));
  const escape = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return `${BEGIN}\n\n${data.capabilities.length} required entries: ${STATUSES.map(s => `${counts[s]} ${s}`).join(', ')}. These counts describe migration work, not a completion percentage.\n\n| Stable ID | Capability | Native location | Stage | Status |\n|---|---|---|---|---|\n`
    + data.capabilities.map(c => `| \`${c.id}\` | ${escape(c.title)} | ${escape(c.desktop.location)} | ${c.desktop.stage} | ${c.status} |`).join('\n') + `\n\n${END}`;
}
function updatedGuide(guide, data) {
  const start = guide.indexOf(BEGIN), end = guide.indexOf(END);
  if (start < 0 || end < start || guide.indexOf(BEGIN, start + BEGIN.length) >= 0 || guide.indexOf(END, end + END.length) >= 0) throw new Error('Guide requires exactly one parity table marker pair.');
  return guide.slice(0, start) + renderTable(data) + guide.slice(end + END.length);
}
function stableV3(version) { return typeof version === 'string' && /^(?:[3-9]|[1-9][0-9]+)\.[0-9]+\.[0-9]+(?:\+[a-zA-Z0-9.-]+)?$/.test(version); }
function stableMetadata() {
  const npm = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const cargo = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8').match(/\[workspace\.package\]([^[]+)/)?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!cargo || !npm) throw new Error('Cannot determine package/Cargo versions.');
  return stableV3(npm) || stableV3(cargo);
}
function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }); }
function readPrevious(ref) {
  if (!SHA.test(ref)) throw new Error('Comparison requires a full Git commit.');
  git(['cat-file', '-e', `${ref}^{commit}`]);
  if (!git(['ls-tree', '--name-only', ref, '--', REGISTER]).trim()) return null;
  return JSON.parse(git(['show', `${ref}:${REGISTER}`]));
}
function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--release', '--write-doc', '--base-ref', '--baseline-files']);
  let ref;
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (args[i] === '--base-ref') { ref = args[++i]; if (!SHA.test(ref || '')) throw new Error('--base-ref requires a full Git commit'); }
  }
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, REGISTER), 'utf8'));
  const release = args.includes('--release') || stableMetadata();
  const errors = validateRegister(data, { release, previous: ref ? readPrevious(ref) : null });
  if (args.includes('--baseline-files')) {
    const baselineFiles = new Set(git(['ls-tree', '-r', '--name-only', BASELINE]).trim().split(/\r?\n/));
    for (const c of data.capabilities.filter(c => c.origin === 'baseline')) {
      for (const file of [...c.reference.sources, ...c.tests.reference]) if (!baselineFiles.has(file)) errors.push(`${c.id}: not in released baseline: ${file}`);
    }
  }
  const guidePath = path.join(ROOT, GUIDE);
  const guide = fs.readFileSync(guidePath, 'utf8').replace(/\r\n/g, '\n');
  const rendered = updatedGuide(guide, data);
  if (args.includes('--write-doc') && !errors.length) fs.writeFileSync(guidePath, rendered);
  else if (rendered !== guide) errors.push('Parity table is stale; run npm run parity:docs and review the diff.');
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; return; }
  console.log(`Parity register valid: ${data.capabilities.length} entries. ${release ? 'All entries have declared native verification; release evidence still requires review.' : 'Incomplete migration allowed; this is not release acceptance.'}`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { validateRegister, renderTable, updatedGuide, stableV3, readPrevious, BASELINE, PLATFORMS, STATUSES };
