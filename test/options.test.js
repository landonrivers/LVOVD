process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sourceSummary,
  capabilitySummary,
  classifyPreviewError,
  parseMediaUrl,
  normalizeOptions,
  normalizeSelection,
  formatSelector,
  buildYtdlpArgs
} = require('../server');

test('compatible AV prefers H.264 + AAC and respects a resolution cap', () => {
  const options = normalizeOptions({ content: 'av', profile: 'compatible', maxHeight: 1080 });
  const selector = formatSelector(options);
  assert.match(selector, /vcodec\^=avc1/);
  assert.match(selector, /acodec\^=mp4a/);
  assert.match(selector, /height<=\?1080/);
});

test('video only maximum quality requests a video-only stream', () => {
  const options = normalizeOptions({ content: 'video', profile: 'maximum' });
  assert.equal(formatSelector(options), 'bestvideo');
});

test('audio only uses bestaudio and can request source audio without conversion', () => {
  const options = normalizeOptions({ content: 'audio', audioFormat: 'source' });
  assert.equal(formatSelector(options), 'bestaudio');
  const args = buildYtdlpArgs(
    { url: 'https://video.example/watch/ABCDEFGHIJK' },
    options,
    '/tmp/%(title)s.%(ext)s',
    'download:test'
  );
  assert.equal(args.includes('--extract-audio'), false);
});

test('extras only skips media and requests selected companion files', () => {
  const options = normalizeOptions({
    content: 'extras',
    extras: { thumbnail: true, metadata: true, subtitles: true, subtitleMode: 'both', subtitleLanguage: 'en' }
  });
  const args = buildYtdlpArgs(
    { url: 'https://video.example/watch/ABCDEFGHIJK' },
    options,
    '/tmp/%(title)s.%(ext)s',
    'download:test'
  );
  assert.ok(args.includes('--skip-download'));
  assert.ok(args.includes('--write-thumbnail'));
  assert.ok(args.includes('--write-info-json'));
  assert.ok(args.includes('--write-subs'));
  assert.ok(args.includes('--write-auto-subs'));
});

test('custom sections and SponsorBlock removal become yt-dlp arguments', () => {
  const options = normalizeOptions({
    content: 'av',
    range: { type: 'custom', start: '00:01:00', end: '00:02:30' },
    sponsor: { mode: 'remove', categories: ['sponsor', 'intro'] }
  });
  const args = buildYtdlpArgs(
    { url: 'https://video.example/watch/ABCDEFGHIJK', section: { start: 60, end: 150 } },
    options,
    '/tmp/%(title)s.%(ext)s',
    'download:test'
  );
  const sectionIndex = args.indexOf('--download-sections');
  assert.equal(args[sectionIndex + 1], '*00:01:00-00:02:30');
  const sponsorIndex = args.indexOf('--sponsorblock-remove');
  assert.equal(args[sponsorIndex + 1], 'sponsor,intro');
});

test('media URL validation accepts arbitrary http/https source services', () => {
  assert.equal(parseMediaUrl('https://vimeo.com/12345'), 'https://vimeo.com/12345');
  assert.throws(() => parseMediaUrl('file:///tmp/video.mp4'), /http\/https/);
});

test('playlist selection is de-duplicated and rejects malformed URLs', () => {
  const selection = normalizeSelection({ entryUrls: [
    'https://example.com/video/1',
    'https://example.com/video/1',
    '../bad',
    'https://example.net/video/2'
  ] });
  assert.deepEqual(selection.entryUrls, ['https://example.com/video/1', 'https://example.net/video/2']);
});


test('capability discovery describes a generic Instagram-style media item from yt-dlp metadata', () => {
  const info = {
    extractor: 'Instagram',
    extractor_key: 'Instagram',
    webpage_url: 'https://www.instagram.com/reel/example/',
    thumbnail: 'https://cdn.example/thumb.jpg',
    formats: [
      { format_id: 'v1', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 30 },
      { format_id: 'a1', vcodec: 'none', acodec: 'mp4a.40.2' }
    ]
  };
  const caps = capabilitySummary(info, info.webpage_url);
  assert.equal(caps.source.name, 'Instagram');
  assert.equal(caps.media.video, true);
  assert.equal(caps.media.audio, true);
  assert.equal(caps.media.compatibleAv, true);
  assert.deepEqual(caps.media.h264Heights, [1080]);
  assert.equal(caps.extras.thumbnail, true);
  assert.equal(caps.extras.chapters, false);
  assert.equal(caps.extras.sponsorBlock, false);
});

test('audio-only sources disable video capabilities but retain metadata and audio', () => {
  const info = {
    extractor_key: 'Soundcloud',
    webpage_url: 'https://soundcloud.com/example/track',
    formats: [
      { format_id: 'http_mp3', vcodec: 'none', acodec: 'mp3' }
    ]
  };
  const caps = capabilitySummary(info, info.webpage_url);
  assert.equal(caps.media.video, false);
  assert.equal(caps.media.audio, true);
  assert.equal(caps.media.audioOnly, true);
  assert.equal(caps.extras.metadata, true);
});

test('source summary falls back to hostname for generic extractor results', () => {
  const source = sourceSummary({ extractor: 'generic', webpage_url: 'https://media.example.org/watch/123' }, 'https://media.example.org/watch/123');
  assert.equal(source.name, 'media.example.org');
  assert.equal(source.generic, true);
});

test('preview errors distinguish authentication, unsupported URLs, and DRM', () => {
  assert.equal(classifyPreviewError(new Error('Login required: use cookies'), 'https://example.com/x').category, 'authentication');
  assert.equal(classifyPreviewError(new Error('Unsupported URL: https://example.com/x'), 'https://example.com/x').category, 'unsupported');
  assert.equal(classifyPreviewError(new Error('This video is DRM protected'), 'https://example.com/x').category, 'protected');
});

test('combined-only media is recognized for normal playback without claiming native video-only or audio-only streams', () => {
  const info = {
    extractor_key: 'Facebook',
    webpage_url: 'https://facebook.example/reel/1',
    formats: [
      { format_id: 'sd', height: 720, vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2' }
    ]
  };
  const caps = capabilitySummary(info, info.webpage_url);
  assert.equal(caps.media.video, true);
  assert.equal(caps.media.audio, true);
  assert.equal(caps.media.combined, true);
  assert.equal(caps.media.videoOnly, false);
  assert.equal(caps.media.audioOnly, false);
  assert.equal(caps.media.compatibleAv, true);
});
