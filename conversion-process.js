'use strict';

// Long media work has no capability-listing deadline. Cancellation acknowledges
// promptly, but the owning operation/slot remains held until exit is observed.
function runConversionProcess(manager, workspace, command, args, options) {
  return new Promise((resolve, reject) => {
    const spawnFailure = error => Object.assign(error, { failureScope: 'local', localFailure: { operation: 'process_start', tool: command, systemCode: error.code } });
    const signal = workspace.abortController.signal;
    const cancelled = () => Object.assign(new Error('Conversion cancelled.'), { code: 'LVOVD_WORKSPACE_CANCELLED' });
    if (signal.aborted) return reject(cancelled());
    let child;
    try { child = manager.spawnProcess(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return reject(spawnFailure(error)); }
    workspace.child = child;
    const stdout = [], stderr = [];
    let bytes = 0, diagnosticBytes = 0, failure = null, settled = false, exited = false, checking = false;
    let escalation, acknowledgement, closeWait, sizeTimer;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation); clearTimeout(acknowledgement); clearTimeout(closeWait); clearInterval(sizeTimer);
      signal.removeEventListener('abort', onAbort);
      child.stdout.removeListener('data', onStdout); child.stderr.removeListener('data', onStderr);
      child.stdout.removeListener('error', onError); child.stderr.removeListener('error', onError);
      child.removeListener('error', onError); child.removeListener('exit', onExit); child.removeListener('close', onClose);
      if (workspace.child === child) workspace.child = null;
      workspace.conversion.terminationPending = false;
      const diagnostic = Buffer.concat(stderr).toString('utf8');
      if (signal.aborted) reject(cancelled());
      else if (failure) reject(failure);
      else if (code !== 0 || /File size limit reached|filesize limit/i.test(diagnostic)) {
        reject(Object.assign(new Error('Local conversion processing failed.'), {
          diagnostic, failureScope: 'local', localFailure: { operation: 'ffmpeg_processing', tool: command }
        }));
      } else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: diagnostic });
    };
    const stop = error => {
      if (settled || failure) return;
      failure = error;
      if (exited) return finish(1);
      escalation = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        acknowledgement = setTimeout(() => {
          if (settled) return;
          workspace.conversion.terminationPending = true;
          workspace.conversion.message = 'Termination is not yet confirmed. The conversion slot remains reserved.';
          manager.emit(workspace);
        }, manager.conversionTerminationGraceMs);
      }, manager.conversionTerminationGraceMs);
      try { child.kill('SIGTERM'); } catch {}
    };
    const onAbort = () => stop(cancelled());
    const onStdout = chunk => {
      if (failure || settled) return;
      options.onStdout?.(chunk);
      if (options.captureStdout === false) return;
      bytes += chunk.length;
      if (bytes > (options.maxStdoutBytes || 4 * 1024 * 1024)) return stop(new Error('Conversion inspection exceeded its output bound.'));
      stdout.push(Buffer.from(chunk));
    };
    const onStderr = chunk => {
      if (diagnosticBytes < 512 * 1024) stderr.push(Buffer.from(chunk).subarray(0, 512 * 1024 - diagnosticBytes));
      diagnosticBytes += chunk.length;
      if (/File size limit reached|filesize limit/i.test(String(chunk))) stop(new Error('Converted output reached the size limit; truncated output is not accepted.'));
    };
    const onError = error => { if (!child.pid) { failure = spawnFailure(error); finish(1); } else stop(error); };
    const onExit = code => {
      exited = true;
      if (failure || code !== 0) finish(code);
      else closeWait = setTimeout(() => finish(code), manager.conversionTerminationGraceMs);
    };
    const onClose = code => { exited = true; finish(code); };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', onStdout); child.stderr.on('data', onStderr);
    child.stdout.on('error', onError); child.stderr.on('error', onError);
    child.on('error', onError); child.on('exit', onExit); child.on('close', onClose);
    if (command === 'ffmpeg' && workspace.conversion.attemptPath) {
      sizeTimer = setInterval(async () => {
        if (checking || settled) return;
        checking = true;
        try {
          const stat = await manager.fs.stat(workspace.conversion.attemptPath);
          if (stat.size >= manager.maxConvertedBytes) stop(new Error('Converted output reached the 100 GiB size limit.'));
        } catch (error) { if (error.code !== 'ENOENT') stop(error); }
        finally { checking = false; }
      }, 250);
    }
  });
}

async function boundedAcknowledgement(promise, milliseconds) {
  let timer;
  try { await Promise.race([promise.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}

module.exports = { runConversionProcess, boundedAcknowledgement };
