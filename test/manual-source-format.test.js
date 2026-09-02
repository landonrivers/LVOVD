'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeSourceFormatSelection,
  sourceFormatSelector
} = require('../source-format-selection');
const { sourceFormatSummary } = require('../source-formats');
const {
  normalizeOptions,
  formatSelector,
  buildYtdlpArgs,
  startDownload
} = require('../server');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('manual source selections accept only simple literal format ids', () => {
  const combined = normalizeSourceFormatSelection({ mode: 'manual', type: 'combined', combinedId: '22' }, 'av');
  assert.deepEqual(combined, { mode: 'manual', type: 'combined', combinedId: '22' });
  assert.equal(sourceFormatSelector(combined), '22');

  const separate = normalizeSourceFormatSelection({
    mode: 'manual',
    type: 'separate',
    videoId: '137-dash',
    audioId: '140.m4a'
  }, 'av');
  assert.equal(sourceFormatSelector(separate), '137-dash+140.m4a');

  for (const unsafe of ['137+140', '137/140', 'best[height=1080]', 'https://cdn.example/137', '137 140', '(137)']) {
    assert.throws(
      () => normalizeSourceFormatSelection({ mode: 'manual', type: 'combined', combinedId: unsafe }, 'av'),
      /valid combined source format/i
    );
  }
});

test('manual source selection is constrained by current content mode', () => {
  assert.deepEqual(
    normalizeSourceFormatSelection({ mode: 'manual', type: 'video', videoId: '137' }, 'video'),
    { mode: 'manual', type: 'video', videoId: '137' }
  );
  assert.deepEqual(
    normalizeSourceFormatSelection({ mode: 'manual', type: 'audio', audioId: '140' }, 'audio'),
    { mode: 'manual', type: 'audio', audioId: '140' }
  );
  assert.throws(
    () => normalizeSourceFormatSelection({ mode: 'manual', type: 'audio', audioId: '140' }, 'video'),
    /video-only source format/i
  );
  assert.deepEqual(
    normalizeSourceFormatSelection({ mode: 'manual', type: 'combined', combinedId: '22' }, 'extras'),
    { mode: 'automatic' }
  );
});

test('normalized download options use exact manual ids instead of automatic selectors', () => {
  const combined = normalizeOptions({
    content: 'av',
    profile: 'compatible',
    maxHeight: 1080,
    sourceFormat: { mode: 'manual', type: 'combined', combinedId: '22' }
  });
  assert.equal(formatSelector(combined), '22');

  const separate = normalizeOptions({
    content: 'av',
    profile: 'maximum',
    sourceFormat: { mode: 'manual', type: 'separate', videoId: '137', audioId: '140' }
  });
  assert.equal(formatSelector(separate), '137+140');

  const video = normalizeOptions({
    content: 'video',
    sourceFormat: { mode: 'manual', type: 'video', videoId: '137' }
  });
  assert.equal(formatSelector(video), '137');
});

test('manual audio selection still acquires the chosen source before local conversion', () => {
  const options = normalizeOptions({
    content: 'audio',
    audioFormat: 'mp3',
    sourceFormat: { mode: 'manual', type: 'audio', audioId: '251' }
  });
  assert.equal(formatSelector(options), '251');

  const args = buildYtdlpArgs(
    { url: 'https://video.example/watch/example' },
    options,
    '/tmp/%(title)s.%(ext)s',
    'download:test'
  );
  const formatIndex = args.indexOf('--format');
  assert.equal(args[formatIndex + 1], '251');
  assert.equal(args.includes('--extract-audio'), false);
  assert.equal(args.includes('--audio-format'), false);
});

test('manual source format selection is rejected for playlist batches', async () => {
  await assert.rejects(
    startDownload(
      'https://example.com/playlist',
      {
        content: 'av',
        sourceFormat: { mode: 'manual', type: 'combined', combinedId: '22' }
      },
      { entryUrls: ['https://example.com/item/1'] }
    ),
    /single media Previews, not playlist batches/i
  );
});

test('source format Preview metadata marks only unambiguous literal ids selectable', () => {
  const summary = sourceFormatSummary({
    formats: [
      { format_id: '22', url: 'https://cdn.example/combined.mp4', height: 720, vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2' },
      { format_id: '137', url: 'https://cdn.example/video.mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'none' },
      { format_id: '140', url: 'https://cdn.example/audio.m4a', vcodec: 'none', acodec: 'mp4a.40.2' },
      { format_id: '137+140', url: 'https://cdn.example/unsafe.mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'none' },
      { url: 'https://cdn.example/no-id.mp4', height: 720, vcodec: 'avc1.4d401f', acodec: 'none' },
      { format_id: 'direct', url: 'https://cdn.example/unknown.mp4', height: 480 }
    ]
  });

  const byId = Object.fromEntries(summary.formats.map((format) => [format.id, format]));
  assert.equal(byId['22'].selectable, true);
  assert.equal(byId['22'].selectionKind, 'combined');
  assert.equal(byId['137'].selectionKind, 'video');
  assert.equal(byId['140'].selectionKind, 'audio');
  assert.equal(byId['137+140'].selectable, false);
  assert.equal(byId['137+140'].selectionId, null);
  assert.equal(byId['direct'].selectable, false);
  assert.equal(byId['direct'].selectionKind, null);
  const fallback = summary.formats.find((format) => /^format-/.test(format.id));
  assert.ok(fallback);
  assert.equal(fallback.selectable, false);
  assert.equal(fallback.selectionId, null);
});

test('browser manual format UI stays capability-driven and queue-visible', () => {
  const app = read('public/app.js');
  const styles = read('public/styles.css');
  assert.match(app, /Manual source override/);
  assert.match(app, /function currentSourceFormatSelection\(content\)/);
  assert.match(app, /format\.selectable/);
  assert.match(app, /format\.selectionId/);
  assert.match(app, /sourceFormat: currentSourceFormatSelection\(content\)/);
  assert.match(app, /Manual source \$\{selection\.videoId\} \+ \$\{selection\.audioId\}/);
  assert.match(app, /videoOptions\.classList\.toggle\('manual-overridden'/);
  assert.match(app, /function friendlySourceCodec\(codec, mediaType\)/);
  assert.match(app, /\[\/\^\(\?:avc1\|avc3\|h264\)\//);
  assert.match(app, /strong\.textContent = sourceFormatTitle\(format\)/);
  assert.doesNotMatch(app, /strong\.textContent = `Format \$\{format\.id\}/);
  assert.doesNotMatch(app, /textContent = `(?:Format|Source ID) \$\{format\.id\}/);
  assert.match(styles, /#source-formats \.help \{ color: #bbb7c5; font-size: 12px/);
  assert.match(styles, /source-format-title \{ color: #f1eff5; font-size: 13px/);
  assert.match(styles, /source-format-details \{[^}]*color: #bbb8c5; font-size: 11px/);
  assert.doesNotMatch(app, /raw format selector|format selector textbox|sourceFormatSelectorInput/);
});

test('History records manual source ids but Use Again requires a fresh manual choice', () => {
  const history = read('public/history-ui.js');
  assert.match(history, /Source format override/);
  assert.match(history, /manual source format selection \(choose again\)/);
  assert.match(history, /const manualSourceWasUsed = saved\.sourceFormat\?\.mode === 'manual'/);
  assert.match(history, /\['av', 'video'\]\.includes\(savedContent\) && !manualSourceWasUsed/);
  assert.doesNotMatch(history, /selectRadio\('source-format-mode', 'manual'\)/);
});
