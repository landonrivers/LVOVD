// Regenerate the one-second synthetic inputs with a development FFmpeg
// containing libx264, libvpx-vp9, libaom-av1 and libopus.
'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function generate(file, source, args) {
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', source,
    ...args, '-threads', '1', '-movflags', '+faststart', path.join(__dirname, file)], { windowsHide: true });
}
generate('avc.mp4', 'color=red:s=640x360:r=4:d=1', ['-c:v', 'libx264']);
generate('vp9.mp4', 'color=green:s=1280x720:r=4:d=1', ['-c:v', 'libvpx-vp9']);
generate('av1.mp4', 'color=blue:s=1920x1080:r=4:d=1', ['-c:v', 'libaom-av1', '-cpu-used', '8']);
generate('aac.m4a', 'sine=frequency=440:sample_rate=48000:duration=1', ['-c:a', 'aac', '-b:a', '64k']);
generate('opus.mp4', 'sine=frequency=880:sample_rate=48000:duration=1', ['-c:a', 'libopus', '-b:a', '96k']);
