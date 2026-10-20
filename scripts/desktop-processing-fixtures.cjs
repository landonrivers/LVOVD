'use strict';
// Deliberate development reference generation; never loaded by the desktop.
const fs = require('node:fs');
const path = require('node:path');
const processing = require('../processing-plan');
const conversion = require('../conversion-plan');
const { normalizeMediaInspection } = require('../media-inspection');
const { processingArgs, validateProcessingOutput } = require('../processing-command');
const { conversionArgs, validateConversionOutput } = require('../conversion-command');
const fixturePath = path.join(__dirname, '..', 'test', 'fixtures', 'desktop-processing-v1.json');
function capabilities(raw) {
  if (!raw) return null;
  return { ...raw, encoders: new Set(raw.encoders), decoders: new Set(raw.decoders), muxers: new Set(raw.muxers), decoderCodecs: new Map(Object.entries(raw.decoderCodecs)) };
}
function evaluate(item, data) {
  const input = item.input;
  try {
    if (item.operation === 'settings') return { value: processing.normalizeProcessingSettings(input.settings) };
    if (item.operation === 'filename') return { value: processing.processingFilename(input.name, input.extension, input.suffix) };
    const inspection = data.sources[input.source] ?? null;
    const caps = capabilities(data.capabilities[input.capabilities ?? 'full']);
    const request = { workspaceId: 'workbench', sourceAssetId: 'source', inputAssetId: 'source', inputFilename: 'Example.mp4', ...input, inspection, capabilities: caps };
    const legacy = item.operation === 'conversion' || input.kind === 'conversion';
    const value = legacy ? conversion.planConversion(request) : processing.planProcessing(request);
    if (item.operation === 'arguments') return { value: legacy
      ? conversionArgs('@INPUT@', '@OUTPUT@', inspection, value, 100000000)
      : processingArgs('@INPUT@', '@OUTPUT@', inspection, value, { ...(input.attempt || {}), passLogPrefix: '@PASSLOG@' }) };
    if (item.operation === 'validation') {
      (legacy ? validateConversionOutput : validateProcessingOutput)(input.output, value);
      return { value: true };
    }
    // Review keys are opaque per-backend identities, not persisted media policy.
    // Compare every other field; Rust tests independently check key binding.
    delete value.key; delete value.inspectionKey;
    return { value: JSON.parse(JSON.stringify(value)) };
  } catch (e) {
    if (e.workspaceFailure) return { error: { message: e.message, workspaceFailure: e.workspaceFailure } };
    if (e.statusCode !== 400) throw e;
    return { error: { code: 'PROCESSING_REQUEST', message: e.message } };
  }
}
function corpus() {
  const base = normalizeMediaInspection({ format: { format_name: 'mov,mp4', duration: '12', tags: { major_brand: 'isom' } }, chapters: [], streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, avg_frame_rate: '30/1', sample_aspect_ratio: '1:1', start_time: '0', duration: '12', bit_rate: '4000000' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', sample_fmt: 'fltp', start_time: '0.5', duration: '10', bit_rate: '192000' }
  ] }, { sourceSize: 6400000 });
  const sources = { base };
  const source = (name, modify) => { sources[name] = structuredClone(base); modify(sources[name]); };
  source('pcm', s => Object.assign(s.audio, { codec: 'pcm_s24le', sampleFormat: 's32', bitsPerSample: 24, bitsPerRawSample: 24, sampleRate: 44100 }));
  source('audio', s => { s.video = null; s.mediaKind = 'audio'; s.trackCounts.video = 0; s.extraStreams.total = 1; s.durationSeconds = 10.5; });
  for (const [name, modify] of [
    ['hevc', s => { s.video.codec = 'hevc'; s.video.pixelFormat = 'yuv420p10le'; }],
    ['vp9', s => { s.video.codec = 'vp9'; s.container.kind = 'matroska'; }],
    ['odd-rotated', s => Object.assign(s.video, { width: 719, height: 481, rotationDegrees: 90, sampleAspectRatio: '4:3' })],
    ['portrait', s => Object.assign(s.video, { width: 720, height: 1280, sampleAspectRatio: '3:4' })],
    ['hdr', s => { s.video.hdr = true; }], ['alpha', s => { s.video.alpha = true; }],
    ['transform', s => { s.video.orientationSupported = false; }], ['no-video-codec', s => { s.video.codec = null; }],
    ['unknown-fps', s => { s.video.frameRate = null; }], ['unknown-container', s => { s.container.kind = 'unknown'; }],
    ['no-audio', s => { s.audio = null; s.trackCounts.audio = 0; s.extraStreams.total = 1; }],
    ['missing-audio', s => { s.audio = null; }], ['unknown-inventory', s => { s.extraStreams = null; }],
    ['unknown-counts', s => { s.trackCounts.audio = null; }], ['unknown-chapters', s => { s.extraStreams.chapters = null; }],
    ['extras', s => { s.trackCounts = { video: 2, audio: 3, subtitle: 2 }; s.extraStreams = { total: 10, chapters: 3, artwork: 1, other: 2 }; }],
    ['no-duration', s => { s.durationSeconds = null; s.video.durationSeconds = null; s.audio.durationSeconds = null; }],
    ['no-audio-end', s => { s.audio.durationSeconds = null; }], ['no-audio-start', s => { s.audio.startSeconds = null; }],
    ['shifted', s => { s.timeOriginSeconds = 5; s.video.startSeconds = 1; s.video.durationSeconds = 8; s.audio.startSeconds = 0; }],
    ['unknown-audio-rate', s => { s.audio.bitRate = null; }], ['surround', s => { s.audio.channels = 6; s.audio.channelLayout = '5.1(side)'; }],
    ['bad-layout', s => { s.audio.channels = 4; s.audio.channelLayout = '4.0'; }], ['unknown-layout', s => { s.audio.channelLayout = null; }],
    ['mp3-in-mkv', s => { s.container.kind = 'matroska'; s.audio.codec = 'mp3'; }],
  ]) source(name, modify);
  for (const [name, codec, format, bits] of [['s16','pcm_s16le','s16',16],['s24','pcm_s24le','s32',24],['s32','pcm_s32le','s32',32],['f32','pcm_f32le','flt',32],['f64','pcm_f64le','dbl',64],['unknown','flac','s32',null]]) {
    source(`audio-${name}`, s => { Object.assign(s, structuredClone(sources.audio)); s.container.kind = 'wav'; Object.assign(s.audio, { codec, sampleFormat: format, bitsPerSample: bits, bitsPerRawSample: bits, sampleRate: 96000 }); });
  }
  for (const [name, codec, kind] of [['opus','opus','ogg'],['flac','flac','flac'],['mp3','mp3','mp3']]) {
    source(`audio-${name}`, s => { Object.assign(s,structuredClone(sources['audio-s16'])); s.container.kind=kind;s.audio.codec=codec; });
  }
  const codecs = [...new Set(Object.values(sources).flatMap(s => [s.video?.codec,s.audio?.codec]).filter(Boolean))];
  const full = { available: true, version: 'fixture', encoders: ['libx264','aac','libmp3lame','libopus','flac','pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le'], decoders: codecs,
    muxers: ['mp4','mov','matroska','mp3','ogg','flac','wav','null'], decoderCodecs: Object.fromEntries(codecs.map(c => [c,[{name:c==='mp3'?'mp3float':c,software:true}]])) };
  const caps = { full, absent: null, failed: {...full, available:false}, empty: {...full,encoders:[],decoders:[],decoderCodecs:{},muxers:[]} };
  for (const key of ['encoders','muxers','decoderCodecs']) { caps[`no-${key}`] = {...full,[key]:key==='decoderCodecs'?{}:[]}; }
  caps.hardware = {...full,decoderCodecs:Object.fromEntries(codecs.map(c=>[c,[{name:`${c}_qsv`,software:false}]]))};
  const cases=[];
  const add=(id,operation,input)=>cases.push({id,operation,input});
  for (const [name,settings] of [['default',{}],['null',null],['array',[]],['unknown',{filter:'evil'}],['suffix',{filenameSuffix:'-cut'}],['empty-suffix',{filenameSuffix:''}],['path-suffix',{filenameSuffix:'../x'}],['long-suffix',{filenameSuffix:'a'.repeat(61)}],['unicode-suffix',{filenameSuffix:'😀'.repeat(31)}],['inactive',{scale:{width:1200,height:700,percent:50,allowUpscale:true},rate:{crf:5,preset:'slow',maximumMB:3,videoKbps:500,twoPass:true}}]]) add(`settings/${name}`,'settings',{settings});
  for (const field of ['videoCodec','container','frameRate','filenameSuffix','scale','rate','audio']) for (const value of [true,'invalid',null]) add(`settings/${field}/${JSON.stringify(value)}`,'settings',{settings:{[field]:value}});
  for (const [group,field,values] of [['scale','mode',['fit','width','height','percent']],['scale','width',[1,2,2.5,16384,16385]],['scale','height',[1,2,16384,16385]],['scale','percent',[0,1,33.3,100,101]],['scale','allowUpscale',[null,1,false]],['rate','mode',['quality','bitrate','size']],['rate','crf',[-1,0,51,52,4.5]],['rate','preset',['ultrafast','veryslow','bogus']],['rate','videoKbps',[0,1,1e6,1e6+1]],['rate','maximumMB',[0,.001,100*1024**3/1e6,200000]],['rate','twoPass',[null,1,true]],['audio','codec',['aac','mp3','opus','flac','pcm','vorbis']],['audio','bitrateKbps',[7,8,1536,1537]]]) {
    for (const value of values) add(`settings/${group}/${field}/${JSON.stringify(value)}`,'settings',{settings:{[group]:{[field]:value}}});
  }
  const cut = {version:1,keepRanges:[{startSeconds:.125,endSeconds:2.75},{startSeconds:4,endSeconds:8}]};
  const process=(id,source='base',settings={},extra={})=>add(`processing/${id}`,'processing',{source,settings,...extra});
  for (const name of Object.keys(sources)) {
    process(`${name}/original`,name);
    process(`${name}/cuts`,name,{videoCodec:sources[name].video?'h264':'unchanged',audio:{codec:sources[name].video?'aac':'unchanged'}},{editPlan:cut});
  }
  for (const container of ['mp4','mov','matroska','m4a','mp3','opus','flac','wav']) {
    process(`container/${container}`,'base',{container});
    process(`pcm/${container}`,'pcm',{container});
  }
  for (const name of ['audio-s16','audio-s24','audio-s32','audio-f32','audio-f64','audio-unknown']) for (const container of ['flac','wav','opus']) process(`${name}/${container}`,name,{container},{editPlan:cut});
  for (const scale of [{mode:'width',width:800},{mode:'height',height:360},{mode:'fit',width:800,height:450},{mode:'percent',percent:25},{mode:'width',width:4000,allowUpscale:true},{mode:'fit',width:2,height:2}]) {
    for (const name of ['base','odd-rotated','portrait']) process(`scale/${name}/${JSON.stringify(scale)}`,name,{scale});
  }
  for (const codec of ['aac','mp3','opus','flac','pcm']) for (const container of ['mp4','matroska']) process(`codec/${container}/${codec}`,'pcm',{container,audio:{codec}},{editPlan:cut});
  for (const rate of [{mode:'quality',crf:22,preset:'slow'},{mode:'bitrate',videoKbps:500},{mode:'bitrate',videoKbps:1,twoPass:true},{mode:'size',maximumMB:1},{mode:'size',maximumMB:.001}]) for (const name of ['base','no-audio','unknown-audio-rate']) process(`rate/${name}/${JSON.stringify(rate)}`,name,{rate});
  for (const capabilities of Object.keys(caps)) { process(`caps/${capabilities}`,'base',{rate:{mode:'size',maximumMB:2}},{capabilities});process(`noop-caps/${capabilities}`,'hdr',{}, {capabilities}); }
  for (const [id,settings,extra] of [
    ['fps-lower',{frameRate:23.976},{}],['fps-higher',{frameRate:60},{}],['audio-video-conflict',{container:'flac',videoCodec:'h264'},{}],
    ['audio-codec-conflict',{container:'wav',audio:{codec:'flac'}},{}],['flac-bitrate',{container:'flac',audio:{bitrateKbps:128}},{}],
    ['mp3-bitrate',{container:'mp3',audio:{codec:'mp3',bitrateKbps:128}},{}],['bad-mp3-bitrate',{audio:{codec:'mp3',bitrateKbps:129}},{}],
    ['opus-bitrate',{container:'opus',audio:{bitrateKbps:513}},{}],['size-flac',{container:'matroska',rate:{mode:'size',maximumMB:2},audio:{codec:'flac'}},{}],
    ['revision',{}, {draftRevision:4}],['bad-revision',{}, {draftRevision:-1}],['missing-identity',{}, {sourceAssetId:null}],
    ['bad-edit',{}, {editPlan:{version:2,keepRanges:[]}}],['extra-edit-field',{}, {editPlan:{...cut,filename:'evil'}}],
    ['extra-range-field',{}, {editPlan:{version:1,keepRanges:[{startSeconds:0,endSeconds:1,filter:'evil'}]}}],
    ['empty-edit',{}, {editPlan:{version:1,keepRanges:[]}}],['past-end',{}, {editPlan:{version:1,keepRanges:[{startSeconds:0,endSeconds:13}]}}],
    ['null-edit',{}, {editPlan:null}],['full-edit',{}, {editPlan:{version:1,keepRanges:[{startSeconds:0,endSeconds:12}]}}],
  ]) process(id,'pcm',settings,extra);
  process('missing-inspection','absent');
  process('frame-rate-encoding','base',{frameRate:23.976});
  for (const name of ['base','hevc','odd-rotated','hdr','alpha','transform','no-audio','audio','extras','mp3-in-mkv','audio-mp3','surround','bad-layout','unknown-layout','no-audio-end','no-audio-start','unknown-inventory']) {
    for (const targetId of ['broad-compatibility-mp4','m4a-aac','mp3']) add(`conversion/${name}/${targetId}`,'conversion',{source:name,targetId,inputRole:'edited',editPlanKey:'committed-cut'});
  }
  for (const capabilities of Object.keys(caps)) add(`conversion/caps/${capabilities}`,'conversion',{source:'hevc',targetId:'broad-compatibility-mp4',capabilities});
  add('conversion/invalid','conversion',{source:'base',targetId:'evil'});
  for (const name of ['C:\\media\\Example.MOV','/media/a.b.mkv','<>:"|?*.mp4','.mp4','   ','😀'.repeat(92)+'.mp4']) add(`filename/${name}`,'filename',{name,extension:'mkv',suffix:'-trimmed'});
  const data={schemaVersion:1,reference:{release:'v2.7.0',commit:'7e192ad7ddee6478b517a74174cedf6dccd85a19',modules:['processing-plan.js','conversion-plan.js','audio-policy.js','public/edit-plan.js']},sources,capabilities:caps,cases};
  const planCases = cases.filter(c => ['processing','conversion'].includes(c.operation));
  for (const c of planCases) {
    const p=evaluate(c,data).value;
    if (p?.status!=='executable') continue;
    const input={...c.input,kind:c.operation};
    for (const pass of p.passes===2 ? [1,2] : [null]) add(`arguments/${c.id}/${pass}`,'arguments',{...input,attempt:{pass}});
    if (p.passes===2) add(`arguments/${c.id}/correction`,'arguments',{...input,attempt:{pass:2,videoBitrate:20000}});
  }
  for (const id of ['processing/base/cuts','processing/pcm/flac','processing/audio-f64/wav','processing/container/opus','processing/frame-rate-encoding','conversion/hevc/broad-compatibility-mp4','conversion/audio/mp3']) {
    const c=cases.find(c=>c.id===id);const p=evaluate(c,data).value;if(p.status!=='executable')throw new Error(id);
    const output=structuredClone(sources[c.input.source]);const v=p.streams.find(s=>s.role==='video'),a=p.streams.find(s=>s.role==='audio');
    output.container.kind=p.output.container;output.durationSeconds=p.timing.durationSeconds;
    output.trackCounts={video:v?1:0,audio:a?1:0,subtitle:0};output.extraStreams={total:p.streams.length,chapters:0,other:0,artwork:0};
    output.video=v?{...output.video,codec:p.output.videoCodec,pixelFormat:p.output.pixelFormat,width:p.output.width,height:p.output.height,rotationDegrees:p.output.rotationDegrees,sampleAspectRatio:p.output.sampleAspectRatio,frameRate:p.output.frameRate??output.video.frameRate,startSeconds:p.timing.videoStartSeconds??0,durationSeconds:p.timing.videoEndSeconds-(p.timing.videoStartSeconds??0)}:null;
    output.audio=a?{...output.audio,codec:p.output.audioCodec,sampleRate:p.output.sampleRate,channels:p.output.channels,channelLayout:p.output.channelLayout,startSeconds:a.action==='encode'?0:p.timing.audioStartSeconds,durationSeconds:p.timing.audioEndSeconds-(a.action==='encode'?0:p.timing.audioStartSeconds),...(p.output.bitDepth?{bitsPerSample:p.output.bitDepth,bitsPerRawSample:p.output.bitDepth,sampleFormat:p.output.representation==='float'?(p.output.bitDepth===64?'dbl':'flt'):(p.output.bitDepth<=16?'s16':'s32')}: {})}:null;
    const mutations=[['valid',()=>{}],['container',o=>o.container.kind='unknown'],['extra-stream',o=>o.extraStreams.total++],['subtitle',o=>o.trackCounts.subtitle++],['chapters',o=>o.extraStreams.chapters++],['duration',o=>o.durationSeconds+=1],['missing-duration',o=>o.durationSeconds=null]];
    if(v)mutations.push(['video-codec',o=>o.video.codec='hevc'],['width',o=>o.video.width+=2],['rotation',o=>o.video.rotationDegrees=90],['orientation',o=>o.video.orientationSupported=false],['start',o=>o.video.startSeconds+=1],['aspect',o=>o.video.sampleAspectRatio='2:1'],['video-end',o=>o.video.durationSeconds-=1],['frame-rate',o=>o.video.frameRate=5]);
    if(a)mutations.push(['audio-codec',o=>o.audio.codec='unknown'],['rate',o=>o.audio.sampleRate=8000],['channels',o=>o.audio.channels=7],['layout',o=>o.audio.channelLayout='quad'],['unknown-layout',o=>o.audio.channelLayout=null],['precision',o=>{o.audio.sampleFormat='s16';o.audio.bitsPerSample=16;o.audio.bitsPerRawSample=16;}],['audio-start',o=>o.audio.startSeconds+=1],['audio-end',o=>o.audio.durationSeconds-=1]);
    for (const [name,mutate] of mutations) {const changed=structuredClone(output);mutate(changed);add(`validation/${id}/${name}`,'validation',{...c.input,kind:c.operation,output:changed});}
  }
  data.reference.modules.push('processing-command.js','conversion-command.js','local-media-input.js');
  for (const item of cases) item.expected=evaluate(item,data);
  return data;
}
if (require.main===module) {
  if (process.argv[2]!=='--write') throw new Error('Pass --write to deliberately refresh shared reference fixtures.');
  const data=corpus();fs.writeFileSync(fixturePath,JSON.stringify(data,null,2)+'\n');console.log(`Wrote ${data.cases.length} processing/conversion cases.`);
}
module.exports={fixturePath,evaluate};
