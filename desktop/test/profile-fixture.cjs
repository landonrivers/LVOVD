'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startProvider } = require('./download.cjs');

const inputs = path.join(__dirname, 'fixtures', 'profiles');
const tracks = {
  avc: { file: 'avc.mp4', codecs: 'avc1.640016', width: 640, height: 360 },
  vp9: { file: 'vp9.mp4', codecs: 'vp09.00.31.08', width: 1280, height: 720 },
  av1: { file: 'av1.mp4', codecs: 'av01.0.08M.08', width: 1920, height: 1080 },
  aac: { file: 'aac.m4a', codecs: 'mp4a.40.2' },
  opus: { file: 'opus.mp4', codecs: 'opus' },
};

// Expected source payloads follow the released selectors for each manifest.
const cases = [
  { source: 'separate', profile: 'compatible', video: 'avc', audio: 'aac' },
  { source: 'separate', profile: 'maximum', video: 'av1', audio: 'opus' },
  { source: 'separate', profile: 'maximum', cap: 720, video: 'vp9', audio: 'opus' },
  { source: 'separate', profile: 'maximum', cap: 360, video: 'avc', audio: 'opus' },
  { source: 'combined', profile: 'compatible', video: 'avc', audio: 'aac' },
  { source: 'combined', profile: 'maximum', video: 'av1', audio: 'opus' },
  { source: 'modern', profile: 'maximum', video: 'vp9', audio: 'opus' },
];

function manifest(formats, directory) {
  const sets = formats.map(({ file, codecs, width, height }) => {
    const size = fs.statSync(path.join(directory, file)).size;
    const dimensions = width ? ` width="${width}" height="${height}" frameRate="4"` : '';
    return `<AdaptationSet mimeType="${width ? 'video' : 'audio'}/mp4"><Representation id="${file.split('.')[0]}" codecs="${codecs}" bandwidth="${8 * size}"${dimensions}><BaseURL>${file}</BaseURL></Representation></AdaptationSet>`;
  });
  return '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S">' +
    '<Period duration="PT1S">' + sets.join('') + '</Period></MPD>';
}

async function start(ffmpeg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvovd-profiles-'));
  try {
    const assets = new Map();
    for (const { file } of Object.values(tracks)) {
      fs.copyFileSync(path.join(inputs, file), path.join(dir, file));
      assets.set('/' + file, path.join(dir, file));
    }
    function combine(video, audio) {
      const file = 'combined-' + video + '.mp4';
      execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', tracks[video].file, '-i', tracks[audio].file,
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', file], { cwd: dir, timeout: 15000, windowsHide: true });
      assets.set('/' + file, path.join(dir, file));
      return { ...tracks[video], file, codecs: tracks[video].codecs + ',' + tracks[audio].codecs };
    }
    const sources = { separate: Object.values(tracks), combined: [combine('avc', 'aac'), combine('av1', 'opus')],
      modern: [tracks.vp9, tracks.opus] };
    // Short narrow tracks keep the extreme and nonstandard published heights cheap
    // to test. Combined-only AV1 and video-only VP9 distinguish the four menus.
    sources.resolutions = [...sources.combined, tracks.avc, tracks.vp9, tracks.aac, tracks.opus];
    const heights = [144, 240, 480, 540, 1440, 2160, 4320, 8640];
    const encoderArgs = ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x8640:rate=4'];
    for (const height of heights) {
      const file = 'height-' + height + '.mp4';
      encoderArgs.push('-frames:v', '4', '-vf', 'scale=32:' + height, '-threads:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast', file);
      sources.resolutions.push({ file, codecs: 'avc1', width: 32, height });
      assets.set('/' + file, path.join(dir, file));
    }
    execFileSync(ffmpeg, encoderArgs, { cwd: dir, timeout: 30000, windowsHide: true });
    for (const [name, formats] of Object.entries(sources)) {
      const file = name + '.mpd';
      fs.writeFileSync(path.join(dir, file), manifest(formats, dir));
      assets.set('/' + file, path.join(dir, file));
    }
    const provider = await startProvider(path.join(inputs, tracks.avc.file), undefined, assets);
    return {
      unknownResolution: provider.url,
      resolutions: new URL('resolutions.mpd', provider.url).href,
      cases: cases.map(c => ({ ...c, url: new URL(c.source + '.mpd', provider.url).href })),
      async close() { await provider.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}

function probe(ffprobe, file) {
  const data = execFileSync(ffprobe, ['-v', 'error', '-show_entries',
    'format=format_name:stream=index,codec_name,codec_type,width,height,extradata_hash:packet=stream_index,data_hash',
    '-show_data_hash', 'sha256', '-of', 'json', file], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const { format, streams, packets } = JSON.parse(data);
  assert.ok(format.format_name.split(',').includes('mp4'));
  return streams.map(({index, ...stream}) => {
    const hashes = packets.filter(p => p.stream_index === index).map(p => p.data_hash);
    assert.ok(hashes.length && hashes.every(hash => /^SHA256:[0-9a-f]{64}$/i.test(hash)));
    return { ...stream, hashes };
  });
}

function verify(ffprobe, file, scenario) {
  assert.equal(path.extname(file), '.mp4');
  const actual = probe(ffprobe, file);
  assert.equal(actual.length, 2);
  for (const kind of ['video', 'audio']) {
    const expected = probe(ffprobe, path.join(inputs, tracks[scenario[kind]].file));
    assert.equal(expected.length, 1);
    assert.deepEqual(actual.find(s => s.codec_type === kind), expected[0], 'Saved ' + kind + ' differs from ' + scenario[kind]);
  }
}
function verifySourceAudio(ffprobe, file) {
  assert.deepEqual(probe(ffprobe, file), probe(ffprobe, path.join(inputs, tracks.opus.file)));
}
module.exports = { start, verify, verifySourceAudio };

if (require.main === module) {
  const [action, tool, index, file] = process.argv.slice(2);
  if (action === 'serve') {
    start(tool).then(fixture => {
      const { cases, resolutions, unknownResolution } = fixture;
      process.stdout.write(JSON.stringify({ cases, resolutions, unknownResolution }) + '\n');
      process.stdin.resume();
      process.stdin.once('end', () => fixture.close());
    }).catch(error => { console.error(error); process.exitCode = 1; });
  } else if (action === 'verify') verify(tool, file, cases[Number(index)]);
  else if (action === 'verify-audio') verifySourceAudio(tool, index);
  else throw new Error('Unknown fixture operation');
}
