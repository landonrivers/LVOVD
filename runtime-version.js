'use strict';

const { spawn } = require('node:child_process');

const VERSION_TIMEOUT_MS = 5000;
const VERSION_OUTPUT_BYTES = 256 * 1024;
const TERMINATION_GRACE_MS = 250;

// Only the launcher and health handler supply commands/arguments. This probe
// deliberately does not share the acquisition runner or its cancellation owner.
function probeVersion(command, args, label, {
  spawnProcess = spawn, timeoutMs = VERSION_TIMEOUT_MS,
  maxOutputBytes = VERSION_OUTPUT_BYTES, terminationGraceMs = TERMINATION_GRACE_MS
} = {}) {
  return new Promise(resolve => {
    const failure = reason => ({ installed: false, error: `${label}: ${reason}` });
    if (!command) return resolve(failure('not configured.'));
    let child;
    try {
      child = spawnProcess(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve(failure(error.code === 'ENOENT' ? 'not found on PATH.' : 'could not start the version check.'));
    }
    let settled = false, exited = false, problem = null, bytes = 0;
    let deadline, escalation, finalWait;
    const stdout = [], stderr = [];
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(escalation); clearTimeout(finalWait);
      child.stdout.removeListener('data', onStdout); child.stderr.removeListener('data', onStderr);
      child.stdout.removeListener('error', onPipeError); child.stderr.removeListener('error', onPipeError);
      child.removeListener('error', onError); child.removeListener('exit', onExit); child.removeListener('close', onClose);
      // A process can exit while an inherited pipe stays open. A failed probe
      // must not keep the launcher or HTTP response waiting for that pipe.
      if (!result.installed) {
        child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
      }
      resolve(result);
    };
    const stop = reason => {
      if (settled || problem) return;
      problem = failure(reason); clearTimeout(deadline);
      if (exited) return finish(problem);
      escalation = setTimeout(() => {
        finalWait = setTimeout(() => finish(problem), terminationGraceMs);
        try { child.kill('SIGKILL'); } catch {}
      }, terminationGraceMs);
      try { child.kill('SIGTERM'); } catch {}
    };
    const capture = target => chunk => {
      if (settled || problem) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxOutputBytes) return stop('version output exceeded its limit.');
      target.push(buffer);
    };
    const onStdout = capture(stdout), onStderr = capture(stderr);
    const onPipeError = () => stop('could not read the version check.');
    const onError = error => {
      if (settled || problem) return;
      const reason = error.code === 'ENOENT' ? 'not found on PATH.' : 'could not start the version check.';
      if (!child.pid) finish(failure(reason)); else stop(reason);
    };
    const onExit = code => {
      exited = true;
      if (problem) finish(problem);
      else if (code !== 0) stop('version check failed.');
    };
    const onClose = code => {
      exited = true;
      if (settled) return;
      if (problem) return finish(problem);
      if (code !== 0) return finish(failure('version check failed.'));
      const output = Buffer.concat(stdout).toString('utf8').trim() || Buffer.concat(stderr).toString('utf8').trim();
      const version = output.split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
      finish({ installed: true, version: version || 'installed' });
    };
    child.stdout.on('data', onStdout); child.stderr.on('data', onStderr);
    child.stdout.on('error', onPipeError); child.stderr.on('error', onPipeError);
    child.on('error', onError); child.on('exit', onExit); child.on('close', onClose);
    deadline = setTimeout(() => stop('version check timed out.'), timeoutMs);
  });
}

module.exports = { probeVersion, VERSION_TIMEOUT_MS, VERSION_OUTPUT_BYTES };
