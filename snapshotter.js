// =============================================================================
// snapshotter.js — Cannon Fight Lab predictions snapshotter
// =============================================================================
// Runs before each event. Loads the next upcoming UFC card, computes the
// model's verdict per fight using the same edges.js logic the website uses,
// and upserts each prediction into the predictions table.
//
// The predictions table + views (v_predictions_with_results, v_event_accuracy,
// v_overall_accuracy) handle joining to actual results after the event and
// computing hit rate / ROI.
//
// Run manually:    node snapshotter.js
// Run with debug:  node snapshotter.js --verbose
// =============================================================================

// The very first thing this process does, before any require() that could
// throw, is say that it started. A run that produces NO output at all is
// otherwise indistinguishable from a run that never happened — and telling
// those two apart is exactly what cost a summer of missing batches.
console.log(`[snapshotter] process start — node ${process.version}, pid ${process.pid}, ${new Date().toISOString()}`);

// @supabase/supabase-js builds a RealtimeClient inside createClient() even when
// nothing subscribes to anything, and that constructor needs a native
// WebSocket — which Node only has from 22. On Node 20 the failure is a
// websocket-factory stack trace pointing at our createClient line, which reads
// like our bug rather than a runtime-version mismatch. Say what it actually is,
// before the require, so the next person reads one line instead of a trace.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const NODE_MIN = 22;
if (NODE_MAJOR < NODE_MIN) {
  console.error(
    `[snapshotter] FATAL: needs Node ${NODE_MIN}+, got ${process.version}. ` +
    `@supabase/supabase-js requires a native WebSocket. ` +
    `Fix the builder's Node version (package.json "engines.node" and .node-version), not this file.`
  );
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const cflEdges = require('./edges');

const VERBOSE = process.argv.includes('--verbose');
const log = (...args) => console.log('[snapshotter]', ...args);
const debug = (...args) => { if (VERBOSE) console.log('[snapshotter:debug]', ...args); };

// ---- env ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
// Name the one that is missing. "Missing SUPABASE_URL or SUPABASE_SECRET_KEY"
// sends you to check both, and on Railway the two are set in different places.
const missing = [
  !SUPABASE_URL && 'SUPABASE_URL',
  !SUPABASE_KEY && 'SUPABASE_SECRET_KEY',
].filter(Boolean);
if (missing.length) {
  console.error(`[snapshotter] FATAL: missing env var(s): ${missing.join(', ')}`);
  process.exit(1);
}

// persistSession/autoRefreshToken OFF is not a style choice — see the exit
// note at the bottom of this file. The auth refresh timer keeps the Node event
// loop alive, and a cron service that does not exit blocks every later run.
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---- main ----
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  log(`run starting; today=${today}`);

  // 1. Find the next upcoming event.
  const { data: events, error: evErr } = await sb
    .from('events')
    .select('id, name, event_date, location')
    .eq('is_upcoming', true)
    .gte('event_date', today)
    .order('event_date', { ascending: true })
    .limit(1);
  if (evErr) throw new Error('events query failed: ' + evErr.message);
  if (!events || events.length === 0) {
    log('no upcoming events found; nothing to snapshot');
    return;
  }
  const event = events[0];
  log(`next event: ${event.name} on ${event.event_date} (${event.location})`);

  // 2. Load all fights for that event.
  const { data: fights, error: fErr } = await sb
    .from('fights')
    .select('id, event_id, fighter_a_id, fighter_b_id, weight_class, is_main_event, is_title_fight')
    .eq('event_id', event.id);
  if (fErr) throw new Error('fights query failed: ' + fErr.message);
  if (!fights || fights.length === 0) {
    log('no fights found for event; aborting');
    return;
  }
  log(`loaded ${fights.length} fights`);

  // 3. Bulk-load all unique fighters in those fights.
  const fighterIds = new Set();
  fights.forEach(f => {
    if (f.fighter_a_id) fighterIds.add(f.fighter_a_id);
    if (f.fighter_b_id) fighterIds.add(f.fighter_b_id);
  });
  const { data: fighters, error: fgErr } = await sb
    .from('fighters')
    .select(
      'id, name, nickname, division, stance, age, height_in, reach_in, ' +
      'wins, losses, draws, ufc_wins, ufc_losses, ufc_draws, ' +
      'slpm, sapm, td_avg, td_def, str_acc, str_def, sub_avg, last_fight_date'
    )
    .in('id', Array.from(fighterIds));
  if (fgErr) throw new Error('fighters query failed: ' + fgErr.message);
  const fmap = {};
  fighters.forEach(f => fmap[f.id] = f);
  log(`loaded ${fighters.length} fighters`);

  // 4. Load streak / form data.
  const { data: forms, error: rfErr } = await sb
    .from('v_fighter_recent_form')
    .select('fighter_id, current_streak, last_result')
    .in('fighter_id', Array.from(fighterIds));
  if (rfErr) throw new Error('recent_form query failed: ' + rfErr.message);
  const streakMap = {};
  (forms || []).forEach(r => streakMap[r.fighter_id] = r);
  log(`loaded ${(forms || []).length} streak records`);

  // 5. Load cardio data per fighter (per-weight-class + CAREER row).
  const { data: cardios, error: cErr } = await sb
    .from('v_fighter_consistency')
    .select('fighter_id, weight_class, consistency_score, cardio_tier, confidence_tier, recent_fights, r3p_minutes')
    .in('fighter_id', Array.from(fighterIds));
  if (cErr) throw new Error('consistency query failed: ' + cErr.message);
  const cardioMap = {};
  (cardios || []).forEach(r => {
    const slot = cardioMap[r.fighter_id] || (cardioMap[r.fighter_id] = { byWc: {}, career: null });
    const entry = {
      score: r.consistency_score,
      tier_word: r.cardio_tier,
      confidence: r.confidence_tier,
      recent_fights: r.recent_fights,
      r3p_minutes: r.r3p_minutes,
    };
    if (r.weight_class === 'CAREER') slot.career = entry;
    else slot.byWc[r.weight_class] = entry;
  });
  log(`loaded ${(cardios || []).length} cardio rows for ${Object.keys(cardioMap).length} fighters`);

  // 6. Compute predictions for each fight.
  const rows = [];
  const now = new Date().toISOString();
  for (const fight of fights) {
    const a = fmap[fight.fighter_a_id];
    const b = fmap[fight.fighter_b_id];
    if (!a || !b) {
      log(`skipping fight ${fight.id}: missing fighter data`);
      continue;
    }
    const ctx = {
      streakMap,
      cardioMap,
      fightWeightClass: fight.weight_class,
      eventDate: event.event_date,
    };
    const { edges, aProb } = cflEdges.computeEdges(a, b, ctx);
    const verdictPctRaw = aProb > 0.5 ? aProb : (1 - aProb);
    const predictedWinnerId = aProb > 0.5 ? a.id : b.id;
    const predictedWinnerName = aProb > 0.5 ? a.name : b.name;
    const isEven = Math.abs(aProb - 0.5) < 0.025;
    // Strongest edge factor (the 'factor' field, like 'record' or 'cardio').
    const topEdgeFactor = edges.length
      ? edges.reduce((best, e) => e.pct > best.pct ? e : best, edges[0]).factor
      : null;

    const row = {
      event_id: event.id,
      fight_id: fight.id,
      snapshot_label: 'cron_pre_event',
      snapshot_at: now,
      predicted_winner_id: isEven ? null : predictedWinnerId,
      verdict_pct: Math.round(verdictPctRaw * 1000) / 10,
      is_even_matchup: isEven,
      top_edge_factor: topEdgeFactor,
      edge_count: edges.length,
      // closing_odds_american stays null until odds ingestion is wired
    };
    rows.push(row);

    if (VERBOSE) {
      debug(`${a.name} vs ${b.name}:`);
      edges.forEach(e => debug(`  ${e.factor.padEnd(15)} ${e.favors}=${e.fighterName.padEnd(25)} ${e.pct.toFixed(1)}%  ${e.desc}`));
      debug(`  → ${isEven ? 'EVEN' : predictedWinnerName + ' ' + (verdictPctRaw * 100).toFixed(1) + '%'} (${edges.length} edges)`);
    }
  }
  log(`computed ${rows.length} predictions`);

  // Upsert into predictions table.
  // Unique constraint is (fight_id, snapshot_label) — re-running the cron
  // with the same label updates the row rather than duplicating it. If we
  // ever want to capture the model's evolution across the week, change the
  // label per run (e.g. include an ISO date).
  const { error: upErr } = await sb
    .from('predictions')
    .upsert(rows, { onConflict: 'fight_id,snapshot_label' });
  if (upErr) throw new Error('predictions upsert failed: ' + upErr.message);

  log(`✓ wrote ${rows.length} predictions for ${event.name}`);
}

// =============================================================================
// EXITING IS PART OF THE JOB, NOT AN AFTERTHOUGHT
// =============================================================================
// Railway's cron contract, verbatim from its docs:
//
//   "if a previous execution is still running when the next scheduled
//    execution is due, Railway will skip the new cron job"
//
// So a run that finishes its work but never exits does not fail loudly — it
// silently eats EVERY FUTURE RUN. That is the worst available failure mode for
// this service and it is the one it was closest to having: nothing here called
// process.exit() on the success path, and it relied on the event loop draining
// on its own. supabase-js holds keep-alive sockets and (by default) an auth
// refresh timer, either of which can keep Node alive indefinitely.
//
// Two belts:
//   1. autoRefreshToken/persistSession are off at createClient (see above).
//   2. The success path exits explicitly, after flushing stdout.
//
// And a brace: a hard watchdog, so a hung query can never become a hung
// container that blocks next week's run too. The watchdog is unref'd so it
// cannot itself be the thing keeping the process alive.
const WATCHDOG_MS = Number(process.env.SNAPSHOTTER_TIMEOUT_MS || 5 * 60 * 1000);
const watchdog = setTimeout(() => {
  console.error(`[snapshotter] FATAL: still running after ${WATCHDOG_MS}ms — ` +
    'exiting so the next scheduled run is not skipped.');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

function finish(code) {
  clearTimeout(watchdog);
  // Give stdout a tick to flush before the hard exit; process.exit() can
  // truncate a pending write to a pipe, which on Railway is the log stream.
  if (process.stdout.writableLength === 0) process.exit(code);
  else process.stdout.write('', () => process.exit(code));
}

main()
  .then(() => {
    log('done — exiting cleanly so the next scheduled run is not skipped.');
    finish(0);
  })
  .catch(err => {
    console.error('[snapshotter] FATAL:', err.message);
    console.error(err.stack);
    finish(1);
  });
