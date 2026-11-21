'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startProvider } = require('./download.cjs');

// Ordinary HTML and schema.org metadata consumed by the packaged generic extractor.
async function start(ffmpeg) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lvovd-chapter-source-'));
  const video = path.join(directory, 'fixture.mp4');
  const render = spawnSync(ffmpeg, ['-nostdin','-loglevel','error','-f','lavfi','-i',
    'color=red:s=160x96:r=10:d=2[a];color=green:s=160x96:r=10:d=3[b];color=blue:s=160x96:r=10:d=4[c];[a][b][c]concat=n=3:v=1:a=0',
    '-f','lavfi','-i','sine=duration=9','-c:v','libx264','-g','1','-bf','0','-c:a','aac','-movflags','+faststart',video],
    { encoding:'utf8', timeout:30000, windowsHide:true });
  assert.equal(render.status, 0, render.stderr);
  const media = await startProvider(video);
  let stale = false;
  const chapters = [['Opening',0,2],['Middle',2,5],['Ending',5,9]];
  const routes = http.createServer((request,response) => {
    const send = (type,body) => response.writeHead(200,{'Content-Type':type, 'Content-Length':Buffer.byteLength(body)}).end(body);
    if (request.url==='/chapters' || request.url==='/changing') {
      const parts = request.url==='/changing' && stale ? chapters.slice(0,2) : chapters;
      const metadata = {'@context':'https://schema.org','@type':'VideoObject',name:'Chapter fixture',
        contentUrl:media.url,duration:'PT9S',width:160,height:96,hasPart:parts.map(([name,startOffset,endOffset])=>
          ({'@type':'Clip',name,startOffset,endOffset}))};
      send('text/html','<!doctype html><title>Chapter fixture</title><script type="application/ld+json">'+JSON.stringify(metadata)+'</script>');
    } else if (request.url==='/captions') {
      send('text/html','<!doctype html><title>Caption fixture</title><video controls src="'+media.url+'">'+
        '<track kind="subtitles" srclang="en" src="/en.vtt"><track kind="subtitles" srclang="fr" src="/fr.vtt"></video>');
    } else if (['/en.vtt','/fr.vtt'].includes(request.url)) {
      const marker=request.url==='/en.vtt'?'English fixture cue':'French fixture cue';
      send('text/vtt','WEBVTT\n\n00:00:00.500 --> 00:00:01.500\n'+marker+'\n');
    } else { response.writeHead(404).end(); }
  });
  await new Promise((resolve,reject)=>{ routes.once('error',reject); routes.listen(0,'127.0.0.1',resolve); });
  const base='http://127.0.0.1:'+routes.address().port;
  return { chapters:base+'/chapters', changing:base+'/changing', captions:base+'/captions', change:()=>{stale=true;},
    async close() {
      routes.closeAllConnections(); await new Promise(resolve=>routes.close(resolve));
      await media.close(); fs.rmSync(directory,{recursive:true,force:true});
    }
  };
}

function verifyChapters(files,ffmpeg,ffprobe) {
  assert.equal(files.length,2);
  for(const [i,file] of files.entries()) {
    const chapter=i===0?1:3;
    assert.match(path.basename(file),new RegExp(' - Chapter '+chapter+'(?: \\(\\d+\\))?\\.mp4$'));
    const run = (exe,args,encoding) => {
      const result=spawnSync(exe,args,{encoding,timeout:30000,windowsHide:true});
      assert.equal(result.status,0,String(result.stderr)); return result.stdout;
    };
    const facts=JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_type,codec_name:format=duration','-of','json',file],'utf8'));
    assert.deepEqual(facts.streams.map(s=>s.codec_name).sort(),['aac','h264']);
    assert.ok(Math.abs(Number(facts.format.duration)-(chapter===1?2:4))<0.3,'Incorrect chapter duration');
    const pixel=run(ffmpeg,['-nostdin','-v','error','-ss','0.5','-i',file,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
    assert.equal(pixel.length,3);
    const selected=chapter===1?0:2;
    assert.ok(pixel[selected]>220 && pixel[1]<30 && pixel[2-selected]<30,'Exported the wrong source interval');
  }
}
function verifyCaptions(files) {
  assert.equal(files.length,2);
  for(const lang of ['en','fr']) {
    const file=files.find(p=>p.endsWith('.'+lang+'.srt'));
    assert.ok(file);
    const cues=fs.readFileSync(file,'utf8').replace(/\r/g,'');
    assert.match(cues,/1\n00:00:00,500 --> 00:00:01,500\n/);
    assert.ok(cues.includes(lang==='en'?'English fixture cue':'French fixture cue'));
  }
}
module.exports={start,verifyChapters,verifyCaptions};

if (require.main===module) {
  const [action,...args]=process.argv.slice(2);
  if(action==='serve') {
    start(args[0]).then(fixture=>{
      process.stdout.write(JSON.stringify({chapters:fixture.chapters,captions:fixture.captions})+'\n');
      process.stdin.resume();
      process.stdin.once('end',()=>fixture.close());
    }).catch(error=>{console.error(error);process.exitCode=1;});
  } else if(action==='chapters') {
    verifyChapters(args.slice(2),args[0],args[1]);
  } else if(action==='captions') {
    verifyCaptions(args);
  } else { throw new Error('Unknown fixture operation'); }
}
