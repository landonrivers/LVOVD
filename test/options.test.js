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
  buildYtdlpArgs,
  audioConversionArgs
} = require('../server');

test('compatible AV prefers H.264 + AAC and respects a resolution cap', () => {
  const options = normalizeOptions({ content: 'av', profile: 'compatible', maxHeight: 1080 });
  const selector = formatSelector(options);
  assert.match(selector, /vcodec\^=avc1/);
  assert.match(selector, /acodec\^=mp4a/);
  assert.match(selector, /height<=\?1080/);
});

test('maximum AV falls back to a combined best format when separate streams are unavailable', () => {
  const options = normalizeOptions({ content: 'av', profile: 'maximum', maxHeight: 1080 });
  const selector = formatSelector(options);
  assert.match(selector, /bestvideo\[height<=\?1080\]\+bestaudio/);
  assert.match(selector, /\/best\[height<=\?1080\]$/);
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
      { format_id: 'v1', url: 'https://cdn.example/video.mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 30 },
      { format_id: 'a1', url: 'https://cdn.example/audio.m4a', vcodec: 'none', acodec: 'mp4a.40.2' }
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
      { format_id: 'http_mp3', url: 'https://cdn.example/audio.mp3', vcodec: 'none', acodec: 'mp3' }
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
      { format_id: 'sd', url: 'https://cdn.example/reel.mp4', height: 720, vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2' }
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

test('Twitch-style direct video qualities remain downloadable when codec fields are omitted', () => {
  const info = {
    extractor: 'twitch:clips',
    extractor_key: 'TwitchClips',
    webpage_url: 'https://www.twitch.tv/example/clip/ExampleSlug',
    formats: [
      { format_id: '1080', url: 'https://clips-media-assets.example/1080.mp4', height: 1080, fps: 30 },
      { format_id: '720', url: 'https://clips-media-assets.example/720.mp4', height: 720, fps: 30 }
    ]
  };
  const caps = capabilitySummary(info, info.webpage_url);
  assert.equal(caps.source.name, 'Twitch');
  assert.equal(caps.media.video, true);
  assert.equal(caps.media.audio, null);
  assert.equal(caps.media.combined, null);
  assert.equal(caps.media.videoOnly, false);
  assert.equal(caps.media.audioOnly, false);
  assert.equal(caps.media.directMedia, true);
  assert.equal(caps.media.compatibleAv, false);
  assert.equal(caps.media.compatibleVideo, false);
  assert.equal(caps.media.nativeAac, null);
  assert.deepEqual(caps.media.heights, [1080, 720]);
  assert.equal(caps.range.custom, true);
  assert.match(caps.note, /did not identify every codec/i);
});

test('an omitted audio codec is unknown, not proof that a known video stream is video-only', () => {
  const info = {
    extractor_key: 'Example',
    webpage_url: 'https://example.com/watch/1',
    formats: [
      { format_id: '720', url: 'https://cdn.example/media.mp4', height: 720, vcodec: 'avc1.4d401f' }
    ]
  };
  const caps = capabilitySummary(info, info.webpage_url);
  assert.equal(caps.media.video, true);
  assert.equal(caps.media.audio, null);
  assert.equal(caps.media.videoOnly, false);
  assert.equal(caps.media.compatibleVideo, false);
  assert.deepEqual(caps.media.h264Heights, [720]);
});

test('audio conversion choices keep yt-dlp acquisition identical to Source Audio', () => {
  for (const audioFormat of ['m4a', 'mp3', 'opus', 'flac', 'wav']) {
    const options = normalizeOptions({ content: 'audio', audioFormat });
    assert.equal(formatSelector(options), 'bestaudio');
    const args = buildYtdlpArgs(
      { url: 'https://video.example/watch/ABCDEFGHIJK' },
      options,
      '/tmp/%(title)s.%(ext)s',
      'download:test'
    );
    assert.equal(args.includes('--extract-audio'), false);
    assert.equal(args.includes('--audio-format'), false);
    assert.equal(args.includes('--audio-quality'), false);
  }
});

test('local FFmpeg conversion uses high-quality MP3 and compatible AAC settings', () => {
  const mp3 = audioConversionArgs('/tmp/source.webm', '/tmp/output.mp3', 'mp3');
  assert.deepEqual(mp3.slice(-5), ['-c:a', 'libmp3lame', '-q:a', '0', '/tmp/output.mp3']);

  const m4a = audioConversionArgs('/tmp/source.webm', '/tmp/output.m4a', 'm4a');
  assert.ok(m4a.includes('aac'));
  assert.ok(m4a.includes('256k'));
  assert.equal(m4a.at(-1), '/tmp/output.m4a');
});

