'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function executable(name) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name + suffix)).find(file => fs.existsSync(file));
}
function environment() {
  const env = { ...process.env };
  const local = path.join(root, 'outputs', 'desktop-tools');
  const cargo = executable('cargo') || path.join(local, 'cargo', 'bin', 'cargo' + (process.platform === 'win32' ? '.exe' : ''));
  if (!executable('cargo') && fs.existsSync(cargo)) {
    env.CARGO_HOME = path.join(local, 'cargo'); env.RUSTUP_HOME = path.join(local, 'rustup');
    env.PATH = path.dirname(cargo) + path.delimiter + env.PATH;
  }
  for (const [key, name] of [['FFPROBE', 'ffprobe'], ['FFMPEG', 'ffmpeg'], ['NODE', 'node']]) {
    const found = executable(name); if (found) env['LVOVD_DESKTOP_' + key] ||= found;
  }
  const ytdlp = path.join(root, '.lvovd-bin', process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux');
  if (fs.existsSync(ytdlp)) env.LVOVD_DESKTOP_YTDLP ||= ytdlp;
  return { cargo, env };
}
function prepare() {
  const dist = path.join(root, 'desktop', 'dist'); fs.mkdirSync(dist, { recursive: true });
  for (const name of ['index.html', 'app.js', 'native.js', 'styles.css']) fs.copyFileSync(path.join(root, 'desktop', name), path.join(dist, name));
}
function main() {
  prepare();
  const action = process.argv[2] || 'run';
  if (action === 'prepare') return;
  const args = {
    run: ['run', '--locked', '-p', 'lvovd-desktop'],
    build: ['build', '--locked', '-p', 'lvovd-desktop'],
    check: ['clippy', '--locked', '--workspace', '--all-targets', '--', '-D', 'warnings'],
    test: ['test', '--locked', '-p', 'lvovd-core'],
    fmt: ['fmt', '--all', '--', '--check']
  }[action];
  if (!args) throw new Error('Unknown desktop action.');
  const { cargo, env } = environment();
  const result = spawnSync(cargo, [...args, ...process.argv.slice(3)], { cwd: root, env, stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) { console.error('Rust and the platform build tools are required. See docs/desktop-foundation.md.'); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
}
if (require.main === module) main();
module.exports = { environment, prepare };
