// Protocol scenarios over real WebSockets (SPEC.md §3, §6, §7), all under the full invariant Checker:
// disconnect + resume (+ 'replaced'), leaving mid-ballot and mid-turn, host kicks (lobby, game, spectator), spectators
// joining mid-game, Play again with a second game, the host leaving, host passing after the grace period, and an
// ejected host who keeps hosting.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  Bot, assertServerHealthy, expectError, playerById, runTable, sleep, startServer, until,
} from './helpers-sim.js';

const alive = (s, id) => { const p = playerById(s, id); return !!p && p.status === 'alive'; };

function assertClean(r, extra = '') {
  const msg = r.violations.slice(0, 25).join('\n');
  assert.equal(r.violations.length, 0, `invariant violations${extra}:\n${msg}`);
  assert.ok(r.games.length >= 1 && r.games.every((g) => g.done), 'every game must reach the final');
}

async function withServer(opts, fn) {
  const server = await startServer(opts);
  try {
    await fn(server);
    await assertServerHealthy(server);
  } finally {
    await server.stop();
  }
}

describe('scenarios', { concurrency: true }, () => {
  test('disconnect mid-game: offline turns get auto-revealed, offline voter is closed out, resume keeps the hand, then a second socket replaces it', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9001 }, async (server) => {
      const seen = { offline: false, resumed: false, replaced: false, offlineTurns: 0, closedWithOffline: false };
      const r = await runTable(server, {
        n: 9, seed: 'disc', label: 'disconnect',
        scenario: (ctx) => {
          let stage = 0;
          let victim = null;
          let before = null;
          ctx.onRef((s, prev) => {
            if (stage === 0 && s.phase === 'reveal' && s.round === 2) {
              // round 2 goes by descending seat: take a non-host bot that has not spoken yet
              const upcoming = s.turn.order.slice(s.turn.index + 1).filter((id) => alive(s, id) && id !== s.hostId);
              victim = ctx.bots.find((b) => b.id === upcoming[upcoming.length - 1]);
              before = JSON.parse(JSON.stringify(victim.state.me.cards));
              victim.drop();
              stage = 1;
            } else if (stage === 1 && playerById(s, victim.id).connected === false) {
              seen.offline = true;
              stage = 2;
            } else if (stage === 2) {
              if (s.turn && s.turn.speakerId === victim.id) seen.offlineTurns++;
              if (prev && prev.phase === 'vote' && s.phase !== 'vote' && prev.vote.voters.includes(victim.id) && !prev.vote.voted.includes(victim.id)) seen.closedWithOffline = true;
              if (s.phase === 'reveal' && s.round === 4) {
                stage = 3;
                ctx.task((async () => {
                  const res = await victim.resume();
                  assert.equal(res.id, victim.id, 'resume keeps the id');
                  assert.equal(res.state.you.role, 'player');
                  for (const [k, c] of Object.entries(before)) {
                    if (!c.revealed && !res.state.me.cards[k].revealed) assert.equal(res.state.me.cards[k].text, c.text, `hidden ${k} changed across the disconnect`);
                  }
                  seen.resumed = true;
                  await until(() => playerById(ctx.watcher.state, victim.id).connected, 3000, 'the resumed player to show online');
                  // a second socket takes the identity over: the first one gets 'replaced' and nothing more
                  const twin = ctx.addBot(ctx.mkBot(victim.name, { seed: 'twin' }));
                  await twin.resume(victim.room, victim.token);
                  await until(() => victim.replaced, 3000, "the old socket to get 'replaced'");
                  seen.replaced = true;
                  assert.equal(twin.id, victim.id);
                })());
              }
            }
          });
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.ok(seen.offline && seen.resumed && seen.replaced, `scenario incomplete: ${JSON.stringify(seen)}`);
      assert.ok(seen.offlineTurns >= 2, `the offline player should have had turns (had ${seen.offlineTurns})`);
      assert.ok(r.games[0].autoReveals >= 2, `host Next should auto-reveal for the offline speaker (autoReveals=${r.games[0].autoReveals})`);
    });
  });

  test('leave: a voter leaves during an open ballot (votes for them are discarded), and a speaker leaves during their own turn', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9002 }, async (server) => {
      const seen = { ballotLeave: false, discarded: 0, revoted: false, speakerLeave: false, advanced: false };
      const r = await runTable(server, {
        n: 7, seed: 'leave', label: 'leave',
        scenario: (ctx) => {
          let stage = 0;
          let holder = null; // withholds its vote so the ballot stays open
          let leaver = null; // everybody votes against it, then it leaves
          let discardedVoters = [];
          let speaker = null;
          ctx.onRef((s, prev) => {
            if (stage === 0 && s.phase === 'discussion' && s.round === 4) {
              const others = ctx.bots.filter((b) => b !== ctx.host && alive(s, b.id));
              [holder, leaver] = others;
              for (const b of ctx.bots) b.voteFor = (st, cands) => (cands.includes(leaver.id) ? leaver.id : null);
              holder.pause();
              stage = 1;
            } else if (stage === 1 && s.phase === 'vote') {
              const missing = s.vote.voters.filter((id) => !s.vote.voted.includes(id));
              if (missing.length === 1 && missing[0] === holder.id) {
                discardedVoters = s.vote.voted.filter((id) => id !== leaver.id);
                leaver.leave();
                seen.ballotLeave = true;
                stage = 2;
              }
            } else if (stage === 2 && playerById(s, leaver.id).status === 'left') {
              if (s.phase !== 'vote') ctx.fail(`the open ballot ended when a voter left (phase ${s.phase})`);
              else {
                if (s.vote.candidates.includes(leaver.id) || s.vote.voters.includes(leaver.id) || s.vote.voted.includes(leaver.id)) ctx.fail('the leaver is still in candidates/voters/voted');
                seen.discarded = discardedVoters.filter((id) => !s.vote.voted.includes(id)).length;
              }
              for (const b of ctx.bots) b.voteFor = null;
              stage = 3;
              holder.resumePlay();
            } else if (stage === 3 && prev && prev.phase === 'vote' && s.lastVoteResult && s.lastVoteResult !== prev.lastVoteResult) {
              const voterIds = s.lastVoteResult.tally.flatMap((e) => e.voterIds);
              if (s.lastVoteResult.tally.some((e) => e.targetId === leaver.id)) ctx.fail('the leaver is in the tally');
              seen.revoted = discardedVoters.every((id) => voterIds.includes(id));
              stage = 4;
            } else if (stage === 4 && s.phase === 'reveal' && s.round === 5) {
              // pause a later speaker so it is still on its turn when it leaves
              const upcoming = s.turn.order.slice(s.turn.index + 1).filter((id) => alive(s, id) && id !== s.hostId);
              speaker = ctx.bots.find((b) => b.id === upcoming[0]);
              speaker.pause();
              stage = 5;
            } else if (stage === 5 && s.phase === 'reveal' && s.turn.speakerId === speaker.id) {
              speaker.leave();
              seen.speakerLeave = true;
              stage = 6;
            } else if (stage === 6 && playerById(s, speaker.id).status === 'left') {
              seen.advanced = !(s.turn && s.turn.speakerId === speaker.id);
              stage = 7;
            }
          });
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.ok(seen.ballotLeave && seen.speakerLeave && seen.advanced, `scenario incomplete: ${JSON.stringify(seen)}`);
      assert.ok(seen.discarded >= 1, 'votes cast for the leaver must be discarded');
      assert.ok(seen.revoted, 'voters whose votes were discarded vote again and are counted');
      assert.equal(r.games[0].left, 2);
    });
  });

  test('kick: host kicks in the lobby, a speaker mid-turn and a spectator; non-hosts cannot kick; kicked tokens are revoked', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9003 }, async (server) => {
      const seen = { lobbyKick: false, speakerKick: false, spectatorKick: false, revoked: 0 };
      const r = await runTable(server, {
        n: 6, seed: 'kick', label: 'kick',
        scenario: async (ctx) => {
          const { host, watcher } = ctx;
          // lobby: a 7th player joins and is kicked; seats are renumbered
          const extra = ctx.addClient(new Bot({ url: server.url, name: 'Bot Extra', autoplay: false }));
          await extra.join(ctx.room);
          await watcher.waitFor((s) => s.players.length === 7, 3000, '7 seated');
          await expectError(ctx.bots[1], { t: 'kick', playerId: ctx.bots[2].id }, ['not_host']);
          await expectError(host, { t: 'kick', playerId: host.id }, ['not_allowed']);
          await expectError(host, { t: 'kick', playerId: 'nobody' }, ['not_allowed']);
          host.act({ t: 'kick', playerId: extra.id });
          await until(() => extra.kicked, 3000, 'the lobby kick');
          const s = await watcher.waitFor((st) => st.players.length === 6, 3000, 'the kicked player removed');
          assert.deepEqual(s.players.map((p) => p.seat), [0, 1, 2, 3, 4, 5]);
          seen.lobbyKick = true;
          const probe = ctx.addClient(new Bot({ url: server.url, name: 'Probe', autoplay: false }));
          await assert.rejects(probe.resume(ctx.room, extra.token), (e) => e.code === 'bad_token');
          probe.close();
          seen.revoked++;
          // a spectator to kick later
          const spec = ctx.addClient(new Bot({ url: server.url, name: 'Spec', autoplay: false }));
          await spec.join(ctx.room, { spectator: true });
          let stage = 0;
          let victim = null;
          ctx.onRef((st) => {
            if (stage === 0 && st.phase === 'reveal' && st.round === 2 && st.turn.speakerId !== host.id && !st.turn.hasRevealed) {
              victim = ctx.bots.find((b) => b.id === st.turn.speakerId);
              victim.pause();
              host.act({ t: 'kick', playerId: victim.id });
              stage = 1;
            } else if (stage === 1 && playerById(st, victim.id).status === 'left') {
              if (st.turn && st.turn.speakerId === victim.id) ctx.fail('the kicked speaker still holds the turn');
              seen.speakerKick = true;
              stage = 2;
              ctx.task((async () => {
                await until(() => victim.kicked, 3000, "the {t:'kicked'} message");
                const p2 = new Bot({ url: server.url, name: 'Probe2', autoplay: false });
                await assert.rejects(p2.resume(ctx.room, victim.token), (e) => e.code === 'bad_token');
                p2.close();
                seen.revoked++;
              })());
            } else if (stage === 2 && st.round === 3) {
              host.act({ t: 'kick', playerId: spec.id });
              stage = 3;
            } else if (stage === 3 && !st.spectators.some((x) => x.id === spec.id)) {
              seen.spectatorKick = true;
              stage = 4;
              ctx.task(until(() => spec.kicked, 3000, 'the spectator kicked message'));
            }
          });
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.ok(seen.lobbyKick && seen.speakerKick && seen.spectatorKick && seen.revoked === 2, `scenario incomplete: ${JSON.stringify(seen)}`);
    });
  });

  test('spectators join mid-game (plain join becomes a spectator, names are de-duplicated) and cannot act', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9004 }, async (server) => {
      const seen = { joined: 0 };
      const r = await runTable(server, {
        n: 5, seed: 'spec', label: 'spectate',
        scenario: (ctx) => {
          let stage = 0;
          ctx.onRef((s) => {
            if (stage === 0 && s.phase === 'reveal' && s.round === 3) {
              stage = 1;
              ctx.task((async () => {
                const late = ctx.addClient(new Bot({ url: server.url, name: ctx.host.name, autoplay: false }));
                const res = await late.join(ctx.room); // no spectator flag: the game is running
                assert.equal(res.state.you.role, 'spectator');
                assert.equal(res.state.me, null);
                const me = res.state.spectators.find((x) => x.id === res.id);
                assert.equal(me.name, `${ctx.host.name} (2)`, 'duplicate names get " (2)"');
                seen.joined++;
                const late2 = ctx.addClient(new Bot({ url: server.url, name: 'Watcher', autoplay: false }));
                const res2 = await late2.join(ctx.room.toLowerCase(), { spectator: true });
                assert.equal(res2.state.you.role, 'spectator');
                assert.equal(res2.state.spectators.find((x) => x.id === res2.id).name, 'Watcher (2)');
                seen.joined++;
                await expectError(late, { t: 'takeSeat' }, ['wrong_phase', 'not_allowed']);
                await expectError(late, { t: 'next' }, ['not_host']);
                await expectError(late, { t: 'vote', targetId: ctx.host.id }, ['not_allowed', 'wrong_phase']);
                await expectError(late, { t: 'reveal', category: 'health' }, ['not_your_turn', 'not_allowed', 'wrong_phase']);
                await expectError(late, { t: 'special', uid: 'x' }, ['not_allowed', 'wrong_phase']);
                await expectError(late, { t: 'playAgain' }, ['not_host', 'wrong_phase']);
              })());
            }
          });
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.equal(seen.joined, 2);
    });
  });

  test('Play again: back to the lobby (left players dropped, host/options/log kept, spectators stay), transfer host, second game', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9005 }, async (server) => {
      const seen = { lobby: false, transferred: false };
      const r = await runTable(server, {
        n: 6, seed: 'again', label: 'play-again', games: 2,
        scenario: async (ctx) => {
          const { host, watcher } = ctx;
          host.act({ t: 'setOptions', options: { speechSeconds1: 45, discussionSeconds: 120 } });
          await watcher.waitFor((s) => s.options.speechSeconds1 === 45 && s.options.discussionSeconds === 120, 3000, 'options');
          const ids = watcher.state.players.map((p) => p.id);
          const leaver = ctx.bots[4];
          let finalLogId = 0;
          ctx.onRef((s) => {
            if (!leaver.left && s.phase === 'reveal' && s.round === 1) leaver.leave();
            if (s.phase === 'final') finalLogId = s.log[s.log.length - 1].id;
          });
          ctx.afterPlayAgain = async (s) => {
            assert.deepEqual(s.players.map((p) => p.id), ids.filter((id) => id !== leaver.id), 'left player dropped, order kept');
            assert.deepEqual(s.players.map((p) => p.seat), [0, 1, 2, 3, 4]);
            assert.equal(s.hostId, host.id);
            assert.equal(s.options.speechSeconds1, 45);
            assert.ok(s.spectators.some((x) => x.id === watcher.id), 'the spectator stays a spectator');
            assert.ok(s.log.length && s.log[s.log.length - 1].id >= finalLogId && s.log[0].id <= finalLogId, 'log kept across Play again');
            assert.equal(s.lastVoteResult, null);
            seen.lobby = true;
            const heir = ctx.bots[2];
            host.act({ t: 'transferHost', playerId: heir.id });
            await watcher.waitFor((st) => st.hostId === heir.id, 3000, 'the host transfer');
            await heir.waitFor((st) => st.you.isHost, 3000, 'the heir to see itself as host');
            await expectError(host, { t: 'start' }, ['not_host']);
            seen.transferred = true;
          };
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.equal(r.games.length, 2);
      assert.equal(r.games[1].n, 5);
      assert.ok(seen.lobby && seen.transferred);
    });
  });

  test('the host leaves mid-game: host passes at once to the first connected alive player, who drives the game', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9006 }, async (server) => {
      const seen = { passedTo: null, expected: null };
      const r = await runTable(server, {
        n: 6, seed: 'hostleave', label: 'host-leave',
        scenario: (ctx) => {
          let stage = 0;
          ctx.onRef((s) => {
            if (stage === 0 && s.phase === 'discussion' && s.round === 2) {
              seen.expected = s.players.find((p) => p.status === 'alive' && p.connected && p.id !== ctx.host.id).id;
              ctx.host.leave();
              stage = 1;
            } else if (stage === 1 && playerById(s, ctx.host.id).status === 'left') {
              seen.passedTo = s.hostId;
              stage = 2;
            }
          });
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.equal(seen.passedTo, seen.expected);
    });
  });

  test('host offline past BUNKER_HOST_GRACE_MS: host passes to a connected player; the returning ex-host does not get it back', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9007, env: { BUNKER_HOST_GRACE_MS: '400' } }, async (server) => {
      const seen = { passedTo: null, expected: null, resumedAsNonHost: false, waitedMs: 0 };
      const r = await runTable(server, {
        n: 5, seed: 'grace', label: 'host-grace', stallMs: 5000,
        scenario: (ctx) => {
          let stage = 0;
          let droppedAt = 0;
          ctx.onRef((s) => {
            if (stage === 0 && s.phase === 'reveal' && s.round === 2) {
              seen.expected = s.players.find((p) => p.status === 'alive' && p.id !== ctx.host.id).id;
              ctx.host.drop();
              droppedAt = Date.now();
              stage = 1;
            } else if (stage === 1 && s.hostId !== ctx.host.id) {
              seen.passedTo = s.hostId;
              seen.waitedMs = Date.now() - droppedAt;
              stage = 2;
            } else if (stage === 2 && s.phase === 'reveal' && s.round === 4) {
              stage = 3;
              ctx.task((async () => {
                const res = await ctx.host.resume();
                assert.equal(res.state.you.isHost, false);
                await sleep(50);
                assert.notEqual(ctx.watcher.state.hostId, ctx.host.id);
                seen.resumedAsNonHost = true;
              })());
            }
          });
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.equal(seen.passedTo, seen.expected);
      assert.ok(seen.waitedMs >= 300, `host passed after ${seen.waitedMs} ms, before the 400 ms grace`);
      assert.ok(seen.resumedAsNonHost);
    });
  });

  test('rate limits on (no BUNKER_NO_LIMITS): bots throttled to 16 msg/s play a full game without a single dropped message', { timeout: 90000 }, async (t) => {
    await withServer({ seed: 9009, noLimits: false }, async (server) => {
      const t0 = Date.now();
      const r = await runTable(server, {
        n: 6, seed: 'limits', specials: 0.3, delay: 5, label: 'limits-on', botOpts: { maxRate: 16 }, timeoutMs: 80000, stallMs: 8000,
      });
      t.diagnostic(JSON.stringify({ seconds: (Date.now() - t0) / 1000, dropped: r.droppedActions, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.equal(r.droppedActions, 0, 'no bot action may go unanswered (dropped by the rate limiter)');
    });
  });

  test('an ejected host keeps every host power and drives the game to the final', { timeout: 60000 }, async (t) => {
    await withServer({ seed: 9008 }, async (server) => {
      const seen = { hostEjectedRound: null, hostPressedAfter: false };
      const r = await runTable(server, {
        n: 6, seed: 'ejhost', label: 'ejected-host',
        scenario: (ctx) => {
          const hostId = ctx.host.id;
          for (const b of ctx.bots) b.voteFor = (s, cands) => (cands.includes(hostId) ? hostId : null);
          ctx.onRef((s, prev) => {
            if (seen.hostEjectedRound === null && playerById(s, hostId).status === 'ejected') seen.hostEjectedRound = s.round;
            if (seen.hostEjectedRound !== null && prev && prev.phase === 'discussion' && s.phase !== 'discussion') {
              if (s.hostId !== hostId) ctx.fail('host changed after the ejection');
              seen.hostPressedAfter = true;
            }
          });
        },
      });
      t.diagnostic(JSON.stringify({ ...seen, games: r.games, warnings: r.warnings.slice(0, 5) }));
      assertClean(r);
      assert.ok(seen.hostEjectedRound !== null, 'the host should have been voted out');
      assert.ok(seen.hostPressedAfter, 'the ejected host should have pressed Next afterwards');
    });
  });
});
