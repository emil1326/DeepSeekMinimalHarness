/**
 * A worker that finishes and gets out of the way immediately.
 *
 * It does what the real worker does at the end of a run — and, crucially, in the
 * same **shape**: a message or two, then `done`, then out. That shape is the whole
 * point. The real worker's last acts are an `error` event (when a run failed for a
 * reason worth naming), a timings snapshot, and `done`; it then exits 30 ms later,
 * which is *usually* enough for those bytes to reach the parent.
 *
 * Claude found the consequence before I could reproduce it: a worker that refused
 * to start — `the profile is inside the sandbox` — emitted its `error` and its
 * `done`, and the daemon recorded only *"the worker stopped without finishing
 * (code 0, signal none)"*. The sentence that explained the failure was thrown away
 * by the verdict on the exit.
 *
 * A fixture rather than a mocked `Supervisor`, because the race is in `fork`'s IPC
 * channel and in the order the parent's events fire, and anything that does not put
 * a real child process on the other end cannot reproduce it.
 */
process.on('message', (raw) => {
  if (raw.type !== 'start') return;
  process.send({ type: 'ready', pid: process.pid, runId: raw.runId });
  process.send({
    type: 'event',
    at: new Date().toISOString(),
    body: { type: 'error', message: 'the profile is inside the sandbox, so stop' },
  });
  process.send({ type: 'done', status: 'failed', summary: null });
  process.exit(0);
});
