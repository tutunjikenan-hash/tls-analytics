import type { Queryable } from "../db";
import { context, describeRange, freshness } from "./overview";
import type { RangeQuery } from "./range";

/**
 * Gameplay analytics from the generic event stream (gameplay_events) and runs. Nothing here assumes
 * game mechanics: event names, chapters, stages and areas are whatever the game sends through
 * TLSAnalytics.track(...) (documented in docs/INSTRUMENTATION.md).
 */
export async function gameplayPage(db: Queryable, q: RangeQuery & { chapter?: string; funnel?: string[] }, now = new Date()) {
  const { settings, trackingStart, range: r } = await context(db, q, now);
  const env = q.env;
  const chapter = q.chapter ?? null;
  const funnelSteps = (q.funnel && q.funnel.length >= 2 ? q.funnel : settings.gameplay_funnel).slice(0, 8);
  const W = [env, r.from, r.to, chapter];
  const chapterFilter = `($4::text IS NULL OR chapter = $4)`;

  const [events, outcomes, stages, attempts, deathsByArea, deathsByCause, abandonStages, chapters, durations, funnelRows] = await Promise.all([
    db.query(
      `SELECT name, count(*) AS n, count(DISTINCT player_key) AS players FROM gameplay_events
       WHERE env = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ${chapterFilter} GROUP BY name ORDER BY n DESC LIMIT 100`, W),
    db.query(
      `SELECT count(*) AS started,
              count(*) FILTER (WHERE outcome = 'completed') AS completed,
              count(*) FILTER (WHERE outcome = 'failed') AS failed,
              count(*) FILTER (WHERE outcome = 'abandoned') AS abandoned,
              count(*) FILTER (WHERE outcome IS NULL) AS in_progress,
              count(DISTINCT player_key) AS players,
              count(DISTINCT player_key) FILTER (WHERE outcome = 'completed') AS players_completed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ended_at - started_at)) FILTER (WHERE outcome = 'completed') AS median_complete_sec,
              avg(EXTRACT(EPOCH FROM ended_at - started_at)) FILTER (WHERE outcome = 'completed') AS avg_complete_sec
       FROM runs WHERE env = $1 AND started_at >= $2 AND started_at < $3 AND ${chapterFilter}`, W),
    db.query(
      `SELECT COALESCE(chapter,'—') AS chapter, COALESCE(stage,'—') AS stage, count(*) AS started,
              count(*) FILTER (WHERE outcome = 'completed') AS completed, count(*) FILTER (WHERE outcome = 'failed') AS failed,
              count(*) FILTER (WHERE outcome = 'abandoned') AS abandoned,
              avg(EXTRACT(EPOCH FROM ended_at - started_at)) FILTER (WHERE outcome = 'completed') AS avg_complete_sec,
              avg(attempt) AS avg_attempt
       FROM runs WHERE env = $1 AND started_at >= $2 AND started_at < $3 AND ${chapterFilter}
       GROUP BY 1,2 ORDER BY 1,2 LIMIT 200`, W),
    db.query(
      `SELECT LEAST(attempt, 10) AS attempt, count(*) AS completions FROM runs
       WHERE env = $1 AND started_at >= $2 AND started_at < $3 AND ${chapterFilter} AND outcome = 'completed' GROUP BY 1 ORDER BY 1`, W),
    db.query(
      `SELECT COALESCE(area,'unknown') AS area, count(*) AS n, count(DISTINCT player_key) AS players FROM gameplay_events
       WHERE env = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ${chapterFilter} AND name IN ('death', 'downed') GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, W),
    db.query(
      `SELECT COALESCE(props->>'cause','unknown') AS cause, count(*) AS n FROM gameplay_events
       WHERE env = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ${chapterFilter} AND name IN ('death', 'downed') GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, W),
    db.query(
      `SELECT COALESCE(stage,'—') AS stage, count(*) AS n FROM runs
       WHERE env = $1 AND started_at >= $2 AND started_at < $3 AND ${chapterFilter} AND outcome = 'abandoned' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, W),
    db.query(`SELECT DISTINCT chapter FROM runs WHERE env = $1 AND chapter IS NOT NULL ORDER BY 1 LIMIT 50`, [env]),
    db.query(
      `SELECT width_bucket((EXTRACT(EPOCH FROM ended_at - started_at) / 60)::float8, ARRAY[2,5,10,15,20,30,45,60]::float8[]) AS b, count(*) AS n
       FROM runs WHERE env = $1 AND started_at >= $2 AND started_at < $3 AND ${chapterFilter} AND outcome = 'completed' GROUP BY 1`, W),
    db.query<{ player_key: string; name: string; first: Date }>(
      `SELECT player_key, name, min(occurred_at) AS first FROM gameplay_events
       WHERE env = $1 AND occurred_at >= $2 AND occurred_at < $3 AND ${chapterFilter} AND player_key IS NOT NULL AND name = ANY($5::text[])
       GROUP BY player_key, name`,
      [...W, funnelSteps],
    ),
  ]);

  const o = outcomes.rows[0];
  const started = Number(o.started);
  const finished = Number(o.completed) + Number(o.failed) + Number(o.abandoned);

  // ordered funnel: a player counts at step i if they reached every earlier step at or before it
  const byPlayer = new Map<string, Map<string, number>>();
  for (const x of funnelRows.rows) {
    const m = byPlayer.get(x.player_key) ?? new Map<string, number>();
    m.set(x.name, x.first.getTime());
    byPlayer.set(x.player_key, m);
  }
  const reached = funnelSteps.map(() => 0);
  for (const m of byPlayer.values()) {
    let t = -Infinity;
    for (let i = 0; i < funnelSteps.length; i++) {
      const at = m.get(funnelSteps[i]);
      if (at === undefined || at < t) break;
      reached[i]++;
      t = at;
    }
  }
  const durLabels = ["<2m", "2-5m", "5-10m", "10-15m", "15-20m", "20-30m", "30-45m", "45-60m", "60m+"];
  const durBy = new Map(durations.rows.map((x) => [Number(x.b), Number(x.n)]));

  return {
    range: describeRange(r),
    env,
    chapter,
    generatedAt: now.toISOString(),
    hasData: trackingStart !== null,
    instrumented: events.rows.length > 0 || started > 0,
    freshness: await freshness(db, env),
    chapters: chapters.rows.map((x) => x.chapter as string),
    runs: {
      started,
      completed: Number(o.completed),
      failed: Number(o.failed),
      abandoned: Number(o.abandoned),
      inProgress: Number(o.in_progress),
      players: Number(o.players),
      playersCompleted: Number(o.players_completed),
      completionPct: finished > 0 ? (Number(o.completed) / finished) * 100 : null,
      leftBeforeFinishingPct: finished > 0 ? (Number(o.abandoned) / finished) * 100 : null,
      medianCompleteSec: o.median_complete_sec === null ? null : Number(o.median_complete_sec),
      avgCompleteSec: o.avg_complete_sec === null ? null : Number(o.avg_complete_sec),
    },
    stages: stages.rows.map((x) => {
      const fin = Number(x.completed) + Number(x.failed) + Number(x.abandoned);
      return {
        chapter: x.chapter as string, stage: x.stage as string, started: Number(x.started), completed: Number(x.completed), failed: Number(x.failed),
        abandoned: Number(x.abandoned), completionPct: fin > 0 ? (Number(x.completed) / fin) * 100 : null,
        failPct: fin > 0 ? (Number(x.failed) / fin) * 100 : null,
        avgCompleteSec: x.avg_complete_sec === null ? null : Number(x.avg_complete_sec), avgAttempt: x.avg_attempt === null ? null : Number(x.avg_attempt),
      };
    }),
    completionsByAttempt: attempts.rows.map((x) => ({ attempt: Number(x.attempt) >= 10 ? "10+" : String(x.attempt), completions: Number(x.completions) })),
    completionTimes: durLabels.map((label, i) => ({ bucket: label, runs: durBy.get(i) ?? 0 })),
    deathsByArea: deathsByArea.rows.map((x) => ({ area: x.area as string, deaths: Number(x.n), players: Number(x.players) })),
    deathsByCause: deathsByCause.rows.map((x) => ({ cause: x.cause as string, deaths: Number(x.n) })),
    abandonedAtStage: abandonStages.rows.map((x) => ({ stage: x.stage as string, runs: Number(x.n) })),
    funnel: funnelSteps.map((step, i) => ({ step, players: reached[i], pctOfFirst: reached[0] > 0 ? (reached[i] / reached[0]) * 100 : null })),
    events: events.rows.map((x) => ({ name: x.name as string, count: Number(x.n), players: Number(x.players) })),
  };
}
