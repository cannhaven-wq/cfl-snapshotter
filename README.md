# cfl-snapshotter

Cannon Fight Lab predictions snapshotter. Runs before each UFC event, computes
the model's verdict per fight using `edges.js`, and upserts predictions to
Supabase.

## Why this exists

Without snapshots, every "the model went 80% on UFC Perth" claim is unverifiable
after the fact. The frontend computes verdicts at render time but doesn't store
them. This script locks them in pre-event so we can audit honestly post-event.

## Files in this repo

| File | Purpose |
|---|---|
| `edges.js` | Single source of truth for edge factor logic. Imported by both this script AND the website's index.html. **Do not duplicate edge logic outside this file.** |
| `snapshotter.js` | The actual snapshotter. Loads next event, computes verdicts, upserts. |
| `package.json` | Dependencies (just supabase-js). |

## Running locally

```bash
export SUPABASE_URL='https://uftancejftcryfvbggll.supabase.co'
export SUPABASE_SECRET_KEY='...'
npm install
npm start                 # runs once
npm run verbose           # runs once with per-fight edge debug output
```

## Schema dependency

Requires the `predictions` table from `predictions_schema.sql` (run that against
Supabase first). The unique index `(fight_id, snapshot_label)` enables the
upsert to overwrite re-runs on the same day.

## Railway deployment (cron)

1. Create a new service in the existing `radiant-caring` project on Railway.
2. Connect to this repo.
3. Set environment variables:
   - `SUPABASE_URL` = `https://uftancejftcryfvbggll.supabase.co`
   - `SUPABASE_SECRET_KEY` = `<the legacy service_role key>`
4. Set the start command: `node snapshotter.js`
5. Set cron schedule: `0 18 * * 5` (every Friday at 6 PM UTC).
   - UFC cards are typically Saturday night. Friday 6 PM UTC = Friday 1 PM ET,
     about 24-30 hours before the card. Late enough that lineups are settled,
     early enough to not race the event.
6. Deploy.

## Editing edge logic

If you change `edges.js`, the change applies to BOTH the website and the
snapshotter — that's the whole point of having a single source. Push edges.js
to the snapshotter repo AND copy it into the website repo so the live site
picks it up. Both must reference the same version.

In a future cleanup, host `edges.js` from a single canonical URL (e.g. a CDN or
GitHub Pages) and have both consumers fetch from there.

## What gets stored

Per fight, one row in `predictions` containing:
- which fighter the model picked (or NULL for even matchups)
- verdict %
- whether it was an even matchup
- which edge factor was strongest
- how many edges fired

The verbose mode also logs every edge that fired and the resulting verdict.
That's not stored — it's just for confirming the snapshotter ran correctly.

## After the event

Run the existing `v_predictions_with_results` view to see hit/miss per fight,
and `v_overall_accuracy` for cumulative accuracy. ROI requires
`closing_odds_american` to be filled in; that's a separate workstream.
