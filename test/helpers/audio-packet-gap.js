'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

// Drop encoded packets so the gap is present in the muxed timestamps even
// when the installed encoder repacketizes discontinuous PCM filter frames.
function dropAudioPackets(start, end, pcmSamples) {
  const rechunk = pcmSamples ? `pcm_rechunk=n=${pcmSamples}:p=0,` : '';
  return ['-bsf:a', `${rechunk}noise=drop='gte(pts*tb,${start})*lt(pts*tb,${end})'`];
}

function assertAudioPacketGap(file, start, end) {
  const { packets } = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', file
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }));
  const found = packets.slice(1).some((packet, i) => {
    const previousEnd = Number(packets[i].pts_time) + Number(packets[i].duration_time);
    const nextStart = Number(packet.pts_time);
    // A boundary can fall inside one encoder packet (AAC/MP3 priming included).
    return Math.abs(previousEnd - start) < 0.06 && Math.abs(nextStart - end) < 0.06;
  });
  assert.ok(found, 'generated source must have an audio packet gap from ' + start + 's to ' + end + 's');
}

module.exports = { dropAudioPackets, assertAudioPacketGap };
