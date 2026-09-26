/* Bunker Online — shared client tables (no DOM: app.js, mock.js and tools/e2e.js import it).
 * KICKS is SPEC §2 verbatim: KICKS[N][r-1] = ejections scheduled at the end of round r for N starting players.
 * estimateGame() is SPEC §11 X4's lobby estimate; airlockDeal() is SPEC §11 X1.3's deal table. */

export const KICKS = Object.freeze({
  2: [0, 0, 0, 0, 0, 0, 1],
  3: [0, 0, 0, 0, 0, 1, 1],
  4: [0, 0, 0, 0, 0, 1, 1],
  5: [0, 0, 0, 0, 1, 1, 1],
  6: [0, 0, 0, 0, 1, 1, 1],
  7: [0, 0, 0, 1, 1, 1, 1],
  8: [0, 0, 0, 1, 1, 1, 1],
  9: [0, 0, 1, 1, 1, 1, 1],
  10: [0, 0, 1, 1, 1, 1, 1],
  11: [0, 1, 1, 1, 1, 1, 1],
  12: [0, 1, 1, 1, 1, 1, 1],
  13: [0, 1, 1, 1, 1, 1, 2],
  14: [0, 1, 1, 1, 1, 1, 2],
  15: [0, 1, 1, 1, 1, 2, 2],
  16: [0, 1, 1, 1, 1, 2, 2],
});

/**
 * SPEC §11 X4: the estimated length of a game with `n` players and the timers `o` (seconds), in seconds, plus what
 * the lobby shows: `mid` = round(t/60/5)*5 with a floor of 5, `lo` = floor(0.8t/60), `hi` = ceil(1.25t/60) (minutes).
 */
export function estimateGame(n, o) {
  const row = KICKS[n] || [];
  const s1 = Number(o.speechSeconds1) || 0;
  const s = Number(o.speechSeconds) || 0;
  const d = Number(o.discussionSeconds) || 0;
  const def = Number(o.defenseSeconds) || 0;
  let alive = n;
  let t = 120;                                   // setup reading + final reveal
  for (let r = 1; r <= 7; r++) {
    t += alive * ((r === 1 ? s1 : s) + 10);      // each turn + ~10 s handover/clicking
    t += d;                                      // discussion
    const k = row[r - 1] || 0;
    for (let b = 0; b < k; b++) t += 45 + 0.3 * (2 * def + 45);   // voting; ~30% of ballots tie -> 2 defenses + revote
    alive -= k;
  }
  return {
    seconds: t,
    mid: Math.max(5, Math.round(t / 60 / 5) * 5),
    lo: Math.floor((0.8 * t) / 60),
    hi: Math.ceil((1.25 * t) / 60),
  };
}

/** SPEC §11 X1.3: how many Airlock and "Back from the Forest" cards a game of `n` players deals (none under 4). */
export function airlockDeal(n) {
  if (n < 4) return { airlocks: 0, revives: 0 };
  if (n <= 7) return { airlocks: 2, revives: 1 };
  if (n <= 11) return { airlocks: 3, revives: 1 };
  return { airlocks: 4, revives: 2 };
}
