'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { environment } = require('./desktop.cjs');

// Only include normal Windows dependencies reachable from the shipping host.
// Never emit Cargo's local paths or include the optional test driver.
const destination = process.argv[2];
const { cargo, env } = environment();
const result = spawnSync(cargo, ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'], { env, encoding: 'utf8', maxBuffer: 48 * 1024 * 1024 });
if (result.status !== 0) throw new Error(result.stderr || 'Could not read the locked dependency graph.');
const data = JSON.parse(result.stdout);
const nodes = new Map(data.resolve.nodes.map(node => [node.id, node]));
const host = data.packages.find(pkg => pkg.name === 'lvovd-desktop');
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dep of nodes.get(id).deps) {
    if (dep.dep_kinds.some(kind => kind.kind === null)) visit(dep.pkg);
  }
}
visit(host.id);
const inventory = [];
for (const pkg of data.packages.filter(pkg => pkg.source && included.has(pkg.id))) {
  if (pkg.name.includes('wdio-webdriver')) throw new Error('The test driver entered the package dependency graph.');
  const directory = path.dirname(pkg.manifest_path);
  const licenseDir = path.join(destination, 'rust', pkg.name + '-' + pkg.version);
  const licenseFiles = new Set(fs.readdirSync(directory).filter(name => /^(copying|licen[cs]e|notice|unlicense)(?:$|[-.])/i.test(name)));
  if (pkg.license_file) licenseFiles.add(pkg.license_file);
  for (const name of licenseFiles) {
    const source = path.resolve(directory, name);
    if (!source.startsWith(directory + path.sep) || !fs.statSync(source).isFile()) continue;
    fs.mkdirSync(licenseDir, { recursive: true });
    fs.copyFileSync(source, path.join(licenseDir, path.basename(name)));
  }
  inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: 'https://crates.io/crates/' + pkg.name + '/' + pkg.version });
}
fs.writeFileSync(path.join(destination, 'Rust-components.json'), JSON.stringify(inventory, null, 2) + '\n');
