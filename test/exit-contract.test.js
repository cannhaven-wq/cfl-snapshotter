/* ===========================================================================
   test/exit-contract.test.js — the cron must TERMINATE.

   node test/exit-contract.test.js

   WHY THIS IS THE ONE TEST THIS REPO HAS

   Railway's cron contract, verbatim from its docs:

     "if a previous execution is still running when the next scheduled
      execution is due, Railway will skip the new cron job"

   So for a scheduled service, "finished the work" and "exited" are different
   facts, and only the second one keeps next week's run alive. A process that
   does its job and then hangs does not fail loudly — it silently eats EVERY
   FUTURE RUN, which looks exactly like a cron that was never set.

   This repo was one Friday away from that. Before the fix, snapshotter.js
   never called process.exit() on success and relied on the event loop
   draining; supabase-js holds keep-alive sockets and an auth refresh timer.
   Measured with the stub below: the old file was still alive at 8s and had to
   be SIGKILLed. The current file exits in ~50ms.

   The stub deliberately holds an open setInterval — i.e. it behaves like the
   real client at its worst. If the script only exits when nothing is holding
   the loop open, it does not satisfy the contract and this fails.
   =========================================================================== */

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEADLINE_MS = 8000;
const PKG = path.join(ROOT, 'node_modules', '@supabase', 'supabase-js');

function installStub() {
  if (fs.existsSync(PKG)) fs.renameSync(PKG, PKG + '.real');
  fs.mkdirSync(PKG, { recursive: true });
  fs.writeFileSync(path.join(PKG, 'package.json'),
    JSON.stringify({ name: '@supabase/supabase-js', main: 'index.js' }));
  fs.writeFileSync(path.join(PKG, 'index.js'), `
    setInterval(() => {}, 1000);   // hold the event loop open, like the real client
    function q(){ const p = Promise.resolve({ data: [], error: null });
      p.select=()=>q(); p.eq=()=>q(); p.gte=()=>q(); p.order=()=>q(); p.limit=()=>q();
      p.in=()=>q(); p.upsert=()=>Promise.resolve({ error: null }); return p; }
    exports.createClient = () => ({ from: () => q() });
  `);
}
function removeStub() {
  fs.rmSync(PKG, { recursive: true, force: true });
  if (fs.existsSync(PKG + '.real')) fs.renameSync(PKG + '.real', PKG);
}

function run(env, cb) {
  const t0 = Date.now();
  const child = spawn('node', ['snapshotter.js'], { cwd: ROOT, env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  const timer = setTimeout(() => child.kill('SIGKILL'), DEADLINE_MS);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    cb({ code, signal, ms: Date.now() - t0, out });
  });
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

installStub();
process.on('exit', removeStub);

run({ SUPABASE_URL: 'https://stub.invalid', SUPABASE_SECRET_KEY: 'stub' }, r => {
  console.log('\nsnapshotter with a client holding the event loop open:');
  check('terminates without being killed', r.signal !== 'SIGKILL',
        `still running after ${DEADLINE_MS}ms — Railway would skip every later run`);
  check('exits 0 on the success path', r.code === 0, `exit code ${r.code}`);
  check('prints a start banner before anything can throw',
        /process start/.test(r.out), 'no banner — a silent run is indistinguishable from no run');
  check('says it exited on purpose', /exiting cleanly/.test(r.out));

  // A missing env var must name WHICH one, and must still exit.
  run({ SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' }, r2 => {
    console.log('\nsnapshotter with no credentials:');
    check('exits 1', r2.code === 1, `exit code ${r2.code}`);
    check('names the missing variables', /SUPABASE_URL/.test(r2.out) && /SUPABASE_SECRET_KEY/.test(r2.out));
    check('still prints the banner first', /process start/.test(r2.out));

    console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed — the cron terminates.\n');
    process.exit(failures ? 1 : 0);
  });
});
