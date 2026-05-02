// =============================================================================
// edges.js — Cannon Fight Lab shared verdict logic
// =============================================================================
// Single source of truth for edge factors and verdict computation. Used by
// both the browser frontend (index.html) and the Node snapshotter that
// records predictions before each event.
//
// USAGE in browser:
//   <script src="edges.js"></script>
//   const { edges, aProb } = window.cflEdges.computeEdges(a, b, ctx);
//
// USAGE in Node:
//   const cflEdges = require('./edges');
//   const { edges, aProb } = cflEdges.computeEdges(a, b, ctx);
//
// CONTEXT object (`ctx`) shape:
//   {
//     streakMap: { [fighter_id]: { current_streak, last_result, ... } },
//     cardioMap: { [fighter_id]: { career: {...}, byWc: { [wc]: {...} } } },
//     fightWeightClass: 'Welterweight' | etc,
//     eventDate: 'YYYY-MM-DD'
//   }
//
// EDGE OBJECT shape (returned by each factor):
//   {
//     factor: 'age' | 'record' | 'cardio' | ...   // stable machine-readable id
//     favors: 'a' | 'b',
//     pct: number,                                  // 50.0–78.0
//     fighterName: string,                          // who the edge favors
//     desc: string                                  // plain-text description
//                                                   //   excluding the fighter
//                                                   //   name (which is bolded
//                                                   //   separately at render)
//   }
// =============================================================================

(function (root) {
  'use strict';

  // =========================================================================
  // Constants
  // =========================================================================

  const STYLE_THRESHOLDS = {
    TD_LOW: 1.0,           // below this = doesn't shoot
    TD_HIGH: 2.5,          // above this = active grappler
    SLPM_LOW: 2.0,         // below this = low striking volume
    SLPM_STRIKER: 4.0,     // above this = active striker
  };

  const CARDIO_TIER_RANK = {
    tireless: 5, steady: 4, tapers: 3, fades: 2, collapses: 1,
  };

  // =========================================================================
  // Style classifier & capability gates
  // =========================================================================

  function classifyStyle(fighter) {
    const td = fighter.td_avg;
    const slpm = fighter.slpm;
    if (td == null && slpm == null) return 'unknown';
    if (td == null || slpm == null) return 'well_rounded';
    if (td < STYLE_THRESHOLDS.TD_LOW && slpm >= STYLE_THRESHOLDS.SLPM_LOW) {
      return 'striker';
    }
    if (td >= STYLE_THRESHOLDS.TD_HIGH && slpm < STYLE_THRESHOLDS.SLPM_STRIKER) {
      return 'grappler';
    }
    if (td < STYLE_THRESHOLDS.TD_LOW && slpm < STYLE_THRESHOLDS.SLPM_LOW) {
      return 'low_volume';
    }
    return 'well_rounded';
  }

  function willHaveStriking(a, b) {
    const slpmA = a.slpm == null ? 0 : a.slpm;
    const slpmB = b.slpm == null ? 0 : b.slpm;
    return slpmA >= STYLE_THRESHOLDS.SLPM_LOW || slpmB >= STYLE_THRESHOLDS.SLPM_LOW;
  }

  function willHaveWrestling(a, b) {
    const tdA = a.td_avg == null ? 0 : a.td_avg;
    const tdB = b.td_avg == null ? 0 : b.td_avg;
    return tdA >= STYLE_THRESHOLDS.TD_LOW || tdB >= STYLE_THRESHOLDS.TD_LOW;
  }

  // =========================================================================
  // Cardio lookup helper
  // =========================================================================

  function cardioFor(fighterId, weightClass, cardioMap) {
    if (!cardioMap) return null;
    const slot = cardioMap[fighterId];
    if (!slot) return null;
    if (weightClass && slot.byWc && slot.byWc[weightClass] && slot.byWc[weightClass].tier_word) {
      return Object.assign({}, slot.byWc[weightClass], { source: 'weight_class' });
    }
    if (slot.career && slot.career.tier_word) {
      return Object.assign({}, slot.career, { source: 'career' });
    }
    return null;
  }

  // =========================================================================
  // EDGE FACTORS
  // =========================================================================

  function ageEdge(a, b) {
    if (a.age == null || b.age == null) return null;
    const gap = Math.abs(a.age - b.age);
    if (gap < 1) return null;
    let pct;
    if (gap <= 2)      pct = 52.0;
    else if (gap <= 4) pct = 55.9;
    else if (gap <= 6) pct = 58.2;
    else if (gap <= 9) pct = 63.3;
    else               pct = 65.2;
    // Discount when either fighter is a UFC newcomer (< 5 fights).
    const aTotal = (a.ufc_wins || 0) + (a.ufc_losses || 0);
    const bTotal = (b.ufc_wins || 0) + (b.ufc_losses || 0);
    if (aTotal < 5 || bTotal < 5) {
      pct = 50 + (pct - 50) * 0.5;
    }
    const youngerIsA = a.age < b.age;
    return {
      factor: 'age',
      favors: youngerIsA ? 'a' : 'b',
      pct,
      fighterName: youngerIsA ? a.name : b.name,
      desc: 'is ' + gap + ' year' + (gap === 1 ? '' : 's') + ' younger',
    };
  }

  function streakEdge(a, b, streakMap) {
    const sa = streakMap && streakMap[a.id];
    const sb = streakMap && streakMap[b.id];
    if (!sa || !sb) return null;
    const aWinStreak = Math.max(sa.current_streak || 0, 0);
    const bWinStreak = Math.max(sb.current_streak || 0, 0);
    if (aWinStreak < 2 && bWinStreak < 2) return null;
    if (aWinStreak === bWinStreak) return null;
    const aHotter = aWinStreak > bWinStreak;
    const hotterStreak = aHotter ? aWinStreak : bWinStreak;
    let pct;
    if (hotterStreak >= 5)      pct = 62.9;
    else if (hotterStreak >= 3) pct = 55.1;
    else                        pct = 53.3;
    return {
      factor: 'streak',
      favors: aHotter ? 'a' : 'b',
      pct,
      fighterName: aHotter ? a.name : b.name,
      desc: 'on a ' + hotterStreak + '-fight win streak',
    };
  }

  function lossStreakEdge(a, b, streakMap) {
    const sa = streakMap && streakMap[a.id];
    const sb = streakMap && streakMap[b.id];
    if (!sa || !sb) return null;
    const aLossStreak = Math.max(-(sa.current_streak || 0), 0);
    const bLossStreak = Math.max(-(sb.current_streak || 0), 0);
    if (aLossStreak < 2 && bLossStreak < 2) return null;
    if (aLossStreak === bLossStreak) return null;
    const aColder = aLossStreak > bLossStreak;
    const colderStreak = aColder ? aLossStreak : bLossStreak;
    let pct;
    if (colderStreak >= 5)      pct = 60.0;
    else if (colderStreak >= 3) pct = 55.5;
    else                        pct = 53.0;
    // The edge favors the OPPONENT of the colder fighter.
    return {
      factor: 'loss_streak',
      favors: aColder ? 'b' : 'a',
      pct,
      fighterName: aColder ? b.name : a.name,
      desc: 'opponent on a ' + colderStreak + '-fight skid',
    };
  }

  function postLossEdge(a, b, streakMap, eventDate) {
    const sa = streakMap && streakMap[a.id];
    const sb = streakMap && streakMap[b.id];
    if (!sa || !sb) return null;
    const aOffLoss = sa.last_result !== 'W';
    const bOffLoss = sb.last_result !== 'W';
    if (aOffLoss === bOffLoss) return null;
    const offLossFighter = aOffLoss ? a : b;
    const lfd = offLossFighter.last_fight_date;
    let daysOff = null;
    if (lfd && eventDate) {
      const ms = new Date(lfd + 'T00:00:00Z').getTime();
      const ed = new Date(eventDate + 'T00:00:00Z').getTime();
      daysOff = Math.round((ed - ms) / (1000 * 60 * 60 * 24));
    }
    if (daysOff == null || daysOff < 0) {
      return {
        factor: 'post_loss',
        favors: aOffLoss ? 'b' : 'a',
        pct: 51.5,
        fighterName: (aOffLoss ? b : a).name,
        desc: 'opponent coming off a loss',
      };
    }
    if (daysOff < 180) return null;
    let pct;
    let descSuffix;
    const months = Math.round(daysOff / 30);
    if (daysOff < 270) {
      pct = 51.5;
      descSuffix = 'opponent coming off a loss (' + months + ' months out)';
    } else if (daysOff < 365) {
      pct = 52.5;
      descSuffix = 'opponent off a loss with ' + months + ' months rust';
    } else {
      pct = 58.0;
      descSuffix = 'opponent off a loss with ' + months + ' months rust (major risk)';
    }
    return {
      factor: 'post_loss',
      favors: aOffLoss ? 'b' : 'a',
      pct,
      fighterName: (aOffLoss ? b : a).name,
      desc: descSuffix,
    };
  }

  function stanceReachEdge(a, b) {
    if (!willHaveStriking(a, b)) return null;
    const reachA = a.reach_in;
    const reachB = b.reach_in;
    const stanceA = a.stance;
    const stanceB = b.stance;
    const reachGap = (reachA != null && reachB != null) ? Math.abs(reachA - reachB) : 0;
    const meaningfulReach = reachGap >= 2;
    const cleanA = ['Orthodox', 'Southpaw'].indexOf(stanceA) >= 0;
    const cleanB = ['Orthodox', 'Southpaw'].indexOf(stanceB) >= 0;
    const cleanMixed = cleanA && cleanB && stanceA !== stanceB;

    if (cleanMixed && meaningfulReach) {
      const southpawIsA = stanceA === 'Southpaw';
      const southpawReach = southpawIsA ? reachA : reachB;
      const orthodoxReach = southpawIsA ? reachB : reachA;
      if (southpawReach > orthodoxReach) {
        return {
          factor: 'stance_reach',
          favors: southpawIsA ? 'a' : 'b',
          pct: 57.0,
          fighterName: southpawIsA ? a.name : b.name,
          desc: 'southpaw + ' + reachGap + '" reach combo',
        };
      }
      const orthodoxIsA = !southpawIsA;
      return {
        factor: 'stance_reach',
        favors: orthodoxIsA ? 'a' : 'b',
        pct: 52.0,
        fighterName: orthodoxIsA ? a.name : b.name,
        desc: 'has ' + reachGap + '" reach (offsets stance disadvantage)',
      };
    }
    if (cleanMixed && !meaningfulReach) {
      const southpawIsA = stanceA === 'Southpaw';
      return {
        factor: 'stance_reach',
        favors: southpawIsA ? 'a' : 'b',
        pct: 51.5,
        fighterName: southpawIsA ? a.name : b.name,
        desc: 'southpaw vs orthodox',
      };
    }
    if (meaningfulReach) {
      const aLonger = reachA > reachB;
      return {
        factor: 'stance_reach',
        favors: aLonger ? 'a' : 'b',
        pct: 52.0,
        fighterName: aLonger ? a.name : b.name,
        desc: 'has ' + reachGap + '" reach advantage',
      };
    }
    return null;
  }

  function recordEdge(a, b) {
    const aw = a.wins || 0, al = a.losses || 0;
    const bw = b.wins || 0, bl = b.losses || 0;
    const aTotal = aw + al;
    const bTotal = bw + bl;
    if (aTotal + bTotal < 3) return null;
    const aRate = (aw + 2) / (aTotal + 4);
    const bRate = (bw + 2) / (bTotal + 4);
    const gap = Math.abs(aRate - bRate);
    if (gap < 0.08) return null;
    let pct;
    if (gap >= 0.40)      pct = 72.0;
    else if (gap >= 0.25) pct = 70.0;
    else if (gap >= 0.15) pct = 65.0;
    else                  pct = 60.0;
    const aBetter = aRate > bRate;
    const aRec = aw + '-' + al;
    const bRec = bw + '-' + bl;
    return {
      factor: 'record',
      favors: aBetter ? 'a' : 'b',
      pct,
      fighterName: aBetter ? a.name : b.name,
      desc: 'has stronger pro record (' + (aBetter ? aRec : bRec) + ' vs ' + (aBetter ? bRec : aRec) + ')',
    };
  }

  function slpmEdge(a, b) {
    if (a.slpm == null || b.slpm == null) return null;
    if (!willHaveStriking(a, b)) return null;
    const gap = Math.abs(a.slpm - b.slpm);
    if (gap < 1.0) return null;
    let pct;
    if (gap >= 3.0)      pct = 55.0;
    else if (gap >= 2.0) pct = 53.5;
    else                 pct = 52.0;
    const aBetter = a.slpm > b.slpm;
    return {
      factor: 'slpm',
      favors: aBetter ? 'a' : 'b',
      pct,
      fighterName: aBetter ? a.name : b.name,
      desc: 'throws ' + gap.toFixed(1) + ' more strikes/min',
    };
  }

  function tdDefEdge(a, b) {
    if (a.td_def == null || b.td_def == null) return null;
    if (!willHaveWrestling(a, b)) return null;
    const gap = Math.abs(a.td_def - b.td_def);
    if (gap < 10) return null;
    let pct;
    if (gap >= 30)      pct = 56.0;
    else if (gap >= 20) pct = 54.0;
    else                pct = 52.5;
    const aBetter = a.td_def > b.td_def;
    return {
      factor: 'td_def',
      favors: aBetter ? 'a' : 'b',
      pct,
      fighterName: aBetter ? a.name : b.name,
      desc: 'has ' + gap + 'pp better takedown defense',
    };
  }

  function cardioEdge(a, b, cardioMap, fightWeightClass) {
    const ca = cardioFor(a.id, fightWeightClass, cardioMap);
    const cb = cardioFor(b.id, fightWeightClass, cardioMap);
    if (!ca || !cb) return null;
    if (!ca.tier_word || !cb.tier_word) return null;
    const ra = CARDIO_TIER_RANK[ca.tier_word];
    const rb = CARDIO_TIER_RANK[cb.tier_word];
    if (ra == null || rb == null) return null;
    const tierGap = Math.abs(ra - rb);
    if (tierGap < 3) return null;
    const eitherLimited = (ca.confidence === 'limited' || cb.confidence === 'limited');
    const eitherCareer = (ca.source === 'career' || cb.source === 'career');
    const conservative = eitherLimited || eitherCareer;
    let pct;
    if (tierGap >= 4) pct = conservative ? 56.0 : 58.0;
    else              pct = conservative ? 54.0 : 55.0;
    const aBetter = ra > rb;
    const winnerTier = aBetter ? ca.tier_word : cb.tier_word;
    const loserTier  = aBetter ? cb.tier_word : ca.tier_word;
    const limited = conservative ? ' (limited data)' : '';
    return {
      factor: 'cardio',
      favors: aBetter ? 'a' : 'b',
      pct,
      fighterName: aBetter ? a.name : b.name,
      desc: winnerTier + ' cardio vs ' + loserTier + limited,
    };
  }

  // =========================================================================
  // Verdict computation
  // =========================================================================

  function computeEdges(a, b, ctx) {
    ctx = ctx || {};
    const streakMap = ctx.streakMap || {};
    const cardioMap = ctx.cardioMap || null;
    const wc = ctx.fightWeightClass || null;
    const ed = ctx.eventDate || null;

    const edges = [
      recordEdge(a, b),
      cardioEdge(a, b, cardioMap, wc),
      ageEdge(a, b),
      streakEdge(a, b, streakMap),
      lossStreakEdge(a, b, streakMap),
      postLossEdge(a, b, streakMap, ed),
      tdDefEdge(a, b),
      slpmEdge(a, b),
      stanceReachEdge(a, b),
    ].filter(Boolean);

    // Bayesian combination of edges.
    let aProb = 0.5;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const factor = e.favors === 'a' ? (e.pct / 100) : (1 - e.pct / 100);
      aProb = (aProb * factor) / (aProb * factor + (1 - aProb) * (1 - factor));
    }
    // Cap to prevent stacked-edges runaway.
    const strongest = edges.length ? Math.max.apply(null, edges.map(function (e) { return e.pct; })) / 100 : 0.5;
    const cap = Math.min(0.78, strongest + 0.06);
    if (aProb > cap) aProb = cap;
    if (aProb < 1 - cap) aProb = 1 - cap;

    return { edges, aProb };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  const api = {
    // Constants
    STYLE_THRESHOLDS,
    CARDIO_TIER_RANK,
    // Helpers
    classifyStyle,
    willHaveStriking,
    willHaveWrestling,
    cardioFor,
    // Edge factors (exported for testing / debugging)
    ageEdge,
    streakEdge,
    lossStreakEdge,
    postLossEdge,
    stanceReachEdge,
    recordEdge,
    slpmEdge,
    tdDefEdge,
    cardioEdge,
    // Main entry point
    computeEdges,
  };

  // UMD-style export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.cflEdges = api;
  }
})(typeof window !== 'undefined' ? window : this);
