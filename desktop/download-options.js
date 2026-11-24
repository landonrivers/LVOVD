'use strict';
globalThis.LVOVDDownloadOptions = function (notify) {
  const form = document.getElementById('download-options');
  const el = key => document.getElementById('dl-' + key);
  const cards = key => form.elements.namedItem('dl-' + key + '-card');
  const value = key => key === 'content' || key === 'profile' ? cards(key).value : el(key).value;
  const checked = key => el(key).checked;
  const selected = key => [...el(key).querySelectorAll('input:checked')].map(input => input.value);
  const show = (key, visible) => { el(key).closest('label').hidden = !visible; };
  function list(key, items) {
    el(key).replaceChildren(...items.map(([id, label]) => new Option(label, id)));
  }
  function checks(key, items) {
    el(key).replaceChildren(...items.map(([id, text]) => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = id; input.checked = key === 'categories' && id === 'sponsor';
      label.append(input, text); return label;
    }));
  }
  let preview;
  function seconds(text) {
    if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(text.trim())) return null;
    return text.trim().split(':').reduce((n, part) => n * 60 + Number(part), 0);
  }
  function read() {
    const content = value('content'), mode = value('selection');
    const video = content === 'av' || content === 'video';
    const ids = {combined:['combined'],separate:['video','stream'],video:['video'],audio:['stream']};
    const type = content === 'extras' ? 'full' : value('range');
    const range = type === 'custom' ? {type,start:seconds(value('start')),end:seconds(value('end'))} :
      type === 'chapters' ? {type,indexes:selected('chapters').map(Number)} : {type};
    return {content, profile:value('profile'), audioFormat:value('audio'), maxHeight:video && mode==='automatic' && value('height') ? Number(value('height')) : null,
      formatIds:(ids[mode] || []).map(value), range, metadata:checked('metadata'), thumbnail:checked('thumbnail'),
      subtitles:checked('subs') ? {mode:value('submode'),languages:value('langs').trim()} : null,
      sponsor:content!=='extras' && value('sponsor')!=='off' ? {mode:value('sponsor'),categories:selected('categories')} : null};
  }
  function valid() {
    const o=read(), c=preview.choices;
    return c.available && (o.content==='extras' ? o.metadata || o.thumbnail || o.subtitles : c[o.content])
      && (o.range.type!=='custom' || o.range.start!==null && o.range.end>o.range.start)
      && (o.range.type!=='chapters' || o.range.indexes.length)
      && (!o.subtitles || o.subtitles.languages) && (!o.sponsor || o.sponsor.categories.length);
  }
  function updateMode() {
    const content=value('content'), modes=[['automatic','Automatic']];
    if (content==='av' && value('combined')) modes.push(['combined','One combined format']);
    if (content==='av' && value('video') && value('stream')) modes.push(['separate','Separate video and audio']);
    if (content==='video' && value('video')) modes.push(['video','Exact video format']);
    if (content==='audio' && value('stream')) modes.push(['audio','Exact audio format']);
    list('selection',modes);
    const compatible = content==='video' ? preview.choices.compatibleVideo : preview.profile==='compatible';
    el('profile-compatible').disabled=!compatible;
    if (!compatible) cards('profile').value='maximum';
    if (content==='extras') el('extras').open=true;
  }
  function refresh() {
    const o=read(), mode=value('selection'), c=preview.choices, video=['av','video'].includes(o.content);
    const availableHeights = o.content==='video' ? (o.profile==='compatible' ? c.compatibleVideoHeights : c.videoHeights) :
      (o.profile==='compatible' ? c.compatibleHeights : c.heights);
    const previous=value('height');
    const bestResolution=o.profile==='compatible' ? 'Best compatible resolution' : 'Best available resolution';
    list('height',[['',bestResolution],...[...availableHeights].reverse().map(h=>[h,'Up to '+h+'p'])]);
    if ([...el('height').options].some(opt=>opt.value===previous)) el('height').value=previous;
    el('height').disabled=!video || mode!=='automatic' || !availableHeights.length;
    el('profile-cards').hidden=!(video && mode==='automatic'); show('height',video && mode==='automatic'); show('audio',o.content==='audio');
    el('formats').hidden=o.content==='extras' || !c.formats.length;
    show('combined',mode==='combined'); show('video',['separate','video'].includes(mode)); show('stream',['separate','audio'].includes(mode));
    el('times').hidden=o.content==='extras'; show('start',o.range.type==='custom'); show('end',o.range.type==='custom');
    el('chapters').hidden=o.range.type!=='chapters';
    show('submode',checked('subs')); show('langs',checked('subs'));
    const languages=new Set([...(value('submode')==='auto'?[]:c.manualLanguages),...(value('submode')==='manual'?[]:c.autoLanguages)]);
    list('languages',[...languages].map(lang=>[lang,lang]));
    el('sponsors').hidden=!c.sponsor || o.content==='extras'; el('categories').hidden=!o.sponsor;
    document.getElementById('download-start').textContent=({av:'Download Video',video:'Download Video',audio:'Download Audio',extras:'Download Extras'})[o.content];
    const stem=preview.filename.replace(/\.mp4$/i,''), names=[];
    for (const label of o.range.type==='chapters'?o.range.indexes.map(i=>' - Chapter '+(i+1)):['']) {
      if (video) names.push(stem+label+'.mp4');
      if (o.content==='audio') names.push(stem+label+(o.audioFormat==='source'?' (source extension)':'.'+o.audioFormat));
      if (o.metadata) names.push(stem+label+'.info.json');
      if (o.thumbnail) names.push(stem+label+'.jpg');
      if (o.subtitles) names.push(stem+label+' (selected captions)');
    }
    document.getElementById('download-filename').textContent=names.join(' · ');
  }
  function reset(p) {
    preview=p; const c=p.choices;
    form.hidden=!c?.available;
    if (form.hidden) return;
    form.reset();
    for(const details of form.querySelectorAll('details')) details.open=false;
    for(const card of cards('content')) card.disabled=card.value!=='extras' && !c[card.value];
    cards('content').value=['av','video','audio'].find(key=>c[key]) || 'extras';

    checks('chapters',c.chapters.map(ch=>[ch.index,(ch.index+1)+'. '+ch.title]));
    checks('categories',Object.entries({sponsor:'Sponsor',intro:'Intro',outro:'Outro',selfpromo:'Self-promotion',interaction:'Interaction reminder',preview:'Preview',filler:'Filler',music_offtopic:'Non-music section',hook:'Hook'}));
    function formatLabel(f) {
      const resolution = f.width && f.height ? f.width+' × '+f.height : f.height && f.height+'p';
      return [f.kind==='unknown'?'Stream layout unknown':f.kind, resolution, f.ext, f.fps && f.fps+' fps',
        f.video!=='none' && f.video, f.audio!=='none' && f.audio, f.channels && f.channels+' ch',
        f.sampleRate && f.sampleRate+' Hz', f.kbps && f.kbps+' kbps',
        f.bytes && (f.approximate?'approx. ':'')+(f.bytes/1048576).toFixed(1)+' MiB', f.note, f.id].filter(Boolean).join(' · ');
    }
    for (const [key,kind] of [['combined','combined'],['video','video'],['stream','audio']]) {
      list(key,c.formats.filter(f=>f.selectable && f.kind===kind).map(f=>[f.id,formatLabel(f)]));
    }
    const evidence = c.formats.map(f=>{
      const item=document.createElement('li');
      item.textContent=formatLabel(f);
      return item;
    });
    el('evidence').replaceChildren(...evidence);
    el('format-count').textContent=c.totalFormats>c.formats.length ? 'Showing '+c.formats.length+' of '+c.totalFormats+' formats.' : '';
    el('thumbnail').disabled=!c.thumbnail; el('subs').disabled=!c.manualLanguages.length && !c.autoLanguages.length;
    el('submode').options[1].disabled=!c.manualLanguages.length; el('submode').options[2].disabled=!c.autoLanguages.length;
    el('range').options[2].disabled=!c.chapters.length;
    cards('profile').value=p.profile;
    updateMode(); refresh();
  }
  form.addEventListener('submit',event=>event.preventDefault());
  function changed(event) {
    if (!preview?.choices?.available) return;
    if(event.target.name==='dl-content-card') updateMode();
    refresh(); notify();
  }
  form.addEventListener('change',changed);
  form.addEventListener('input',event=>{ if(event.target.type==='text') changed(event); });
  return {read,valid,reset};
};
