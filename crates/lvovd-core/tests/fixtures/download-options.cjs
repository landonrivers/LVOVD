'use strict';
// Run the released option policy on the same synthetic choices Rust receives.
process.env.LVOVD_DATA_DIR = process.argv[2];
const ref = require('../../../../app-server');
const cases = [];
function compare(native, released, section) {
  const options = ref.normalizeOptions(released);
  const args = ref.buildYtdlpArgs({url:'https://example.invalid/video',section},options,'media.%(ext)s','test');
  const flags = ['--format','--remux-video','--merge-output-format','--download-sections','--sub-langs','--sub-format',
    '--convert-subs','--convert-thumbnails','--sponsorblock-mark','--sponsorblock-remove'];
  const expected = {};
  for(const flag of flags) if(args.includes(flag)) expected[flag]=args[args.indexOf(flag)+1];
  for(const flag of ['--skip-download','--write-info-json','--write-thumbnail','--write-subs','--write-auto-subs']) if(args.includes(flag)) expected[flag]=true;
  const entry = {native, expected};
  if (['av','video'].includes(native.content) && !section) {
    const profile = native.profile || 'compatible';
    const sourceFormat = released.sourceFormat || {mode:'auto'};
    const source = ref.normalizeWorkspaceAcquisition({content:native.content,profile,maxHeight:native.maxHeight,sourceFormat});
    const editor = ref.buildWorkspaceAcquisitionArgs('https://example.invalid/video',source,'media.%(ext)s',8192);
    entry.editor = {format:editor[editor.indexOf('--format')+1], merge:editor.includes('--merge-output-format') ? editor[editor.indexOf('--merge-output-format')+1] : null};
  }
  cases.push(entry);
}
for(const content of ['av','video']) for(const profile of ['compatible','maximum']) for(const maxHeight of [null,144,540,720,8640]) {
  const choice={content,profile,maxHeight}; compare(choice,choice);
}
for(const audioFormat of ['source','m4a','mp3','opus','flac','wav']) {
  const choice={content:'audio',audioFormat,maxHeight:360}; compare(choice,choice);
}
for(const [content,type,ids] of [['av','combined',['c']],['av','separate',['v','a']],['audio','audio',['a']],['video','video',['v']]]) {
  compare({content,maxHeight:360,formatIds:ids},{content,maxHeight:360,sourceFormat:{mode:'manual',type,combinedId:'c',videoId:'v',audioId:'a'}});
}
for(const mode of ['manual','auto','both']) {
  compare({content:'extras',maxHeight:360,thumbnail:true,metadata:true,subtitles:{mode,languages:'en,fr'}},
    {content:'extras',maxHeight:360,extras:{thumbnail:true,metadata:true,subtitles:true,subtitleMode:mode,subtitleLanguage:'en,fr'}});
}
for(const mode of ['mark','remove']) {
  const sponsor={mode,categories:['sponsor','intro','outro','selfpromo','interaction','preview','filler','music_offtopic','hook']};
  compare({sponsor},{sponsor});
}
compare({range:{type:'custom',start:1.5,end:10.5}},{range:{type:'custom',start:1.5,end:10.5}},{start:1.5,end:10.5});
compare({range:{type:'chapters',indexes:[1,0]}},{range:{type:'chapters',chapterIndexes:[1,0]}},{start:8,end:13});
process.stdout.write(JSON.stringify(cases));
