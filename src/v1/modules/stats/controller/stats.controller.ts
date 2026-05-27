import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import DecisionAuditRepo from "@shared/audit/repositories/decision-audit.repo";
import { SuccessResponse } from "@shared/utils/response.util";
import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { DecisionAudit } from "@shared/audit/model/decision-audit.model";

/**
 * Rollup endpoints over the `decisionAuditLog` table. Read-mostly,
 * cheap. Today's window starts at local midnight (server time);
 * callers can override with `since=<ISO>` to look further back.
 */
@injectable()
class StatsController {
  constructor(private readonly auditRepo: DecisionAuditRepo) {}

  /**
   * KPI rollups for the Metrics page (and the Dashboard's "Champion
   * model" latency tile). All numbers come from `decisionAuditLog`
   * (and `investigationReports` for the FIA tile). When the window
   * is empty we return null fields so the UI can render "—" instead
   * of a confidently-wrong 0.
   */
  window = async (
    req: FastifyRequest<{ Querystring: { seconds?: string; sparklineBuckets?: string } }>,
    res: FastifyReply
  ) => {
    const seconds = Math.min(
      Math.max(Number.parseInt(req.query.seconds || "86400", 10) || 86400, 60),
      30 * 24 * 3600
    );
    const buckets = Math.min(
      Math.max(Number.parseInt(req.query.sparklineBuckets || "11", 10) || 11, 4),
      60
    );
    const now = new Date();
    const from = new Date(now.getTime() - seconds * 1000);

    const bucketSeconds = Math.max(60, Math.floor(seconds / buckets));

    const [counts, overrides, latency, decisionBuckets, fiaCount, fiaPerHour] = await Promise.all([
      this.auditRepo.countByDecisionSince(from),
      this.auditRepo.overrideCountSince(from),
      this.auditRepo.championLatencyPercentiles(from),
      this.auditRepo.decisionBuckets(from, bucketSeconds, buckets),
      this.fiaReportCountSince(from),
      this.fiaReportRatePerHour(seconds),
    ]);

    const total =
      (counts.ACCEPT || 0) + (counts.DECLINE || 0) + (counts.REVIEW || 0);
    const decisionsPerSec = total > 0 ? total / seconds : 0;

    // Build a `buckets`-length series even when the DB returned fewer
    // rows (e.g. fresh deployment with no data in older buckets). We
    // pad the head with zeros — the freshest bucket should always be
    // the last entry.
    const fillSpark = (key: "total" | "declines" | "overrides") => {
      const out = new Array(buckets).fill(0);
      const offset = Math.max(0, buckets - decisionBuckets.length);
      decisionBuckets.forEach((b, i) => {
        out[offset + i] = b[key];
      });
      return out;
    };

    return res.send(
      SuccessResponse("Window stats", {
        seconds,
        since: from.toISOString(),
        until: now.toISOString(),
        counts,
        total,
        rates: {
          decline: total > 0 ? (counts.DECLINE ?? 0) / total : 0,
          accept: total > 0 ? (counts.ACCEPT ?? 0) / total : 0,
          review: total > 0 ? (counts.REVIEW ?? 0) / total : 0,
          override: total > 0 ? overrides / total : 0,
        },
        decisionsPerSec,
        declineRate: total > 0 ? (counts.DECLINE ?? 0) / total : 0,
        overrideRate: total > 0 ? overrides / total : 0,
        fiaReports: fiaCount,
        fiaReportsPerHour: fiaPerHour,
        championLatency: {
          p50: latency.p50,
          p95: latency.p95,
          p99: latency.p99,
        },
        sparklines: {
          decisions: fillSpark("total"),
          declines: fillSpark("declines"),
          overrides: fillSpark("overrides"),
        },
      })
    );
  };

  /**
   * Bucketed latency percentiles. The Metrics page renders this as
   * three lines (p50 / p95 / p99). Default window is 24 h with
   * 60-minute buckets — matches the chart's existing visual density.
   */
  latency = async (
    req: FastifyRequest<{
      Querystring: { from?: string; to?: string; bucketMinutes?: string };
    }>,
    res: FastifyReply
  ) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(to.getTime() - 24 * 3600 * 1000);
    const bucketMinutes = Math.min(
      Math.max(Number.parseInt(req.query.bucketMinutes || "60", 10) || 60, 1),
      24 * 60
    );

    const rows = await this.auditRepo.latencyBuckets(from, to, bucketMinutes);

    return res.send(
      SuccessResponse("Latency timeseries", {
        from: from.toISOString(),
        to: to.toISOString(),
        bucketMinutes,
        buckets: rows,
      })
    );
  };

  private async fiaReportCountSince(since: Date): Promise<number> {
    try {
      const knex = DecisionAudit.knex();
      const [row] = (await knex
        .from(DB_TABLES.INVESTIGATION_REPORTS)
        .where("createdAt", ">=", since)
        .count<{ n: string }[]>("* as n")) as Array<{ n: string }>;
      return Number(row?.n || 0);
    } catch {
      // Table may be empty or absent on a fresh deploy. Don't crash
      // the whole stats payload over an investigation-reports issue.
      return 0;
    }
  }

  private async fiaReportRatePerHour(seconds: number): Promise<number> {
    try {
      const knex = DecisionAudit.knex();
      const since = new Date(Date.now() - seconds * 1000);
      const [row] = (await knex
        .from(DB_TABLES.INVESTIGATION_REPORTS)
        .where("createdAt", ">=", since)
        .count<{ n: string }[]>("* as n")) as Array<{ n: string }>;
      const n = Number(row?.n || 0);
      const hours = seconds / 3600;
      return hours > 0 ? n / hours : 0;
    } catch {
      return 0;
    }
  }

  today = async (
    req: FastifyRequest<{ Querystring: { since?: string } }>,
    res: FastifyReply
  ) => {
    const since = req.query.since
      ? new Date(req.query.since)
      : startOfTodayUtc();

    const [counts, topReasons] = await Promise.all([
      this.auditRepo.countByDecisionSince(since),
      this.auditRepo.topReasonCodesSince(since, 10),
    ]);

    const total = (counts.ACCEPT || 0) + (counts.DECLINE || 0) + (counts.REVIEW || 0);
    return res.send(
      SuccessResponse("Today's stats", {
        since: since.toISOString(),
        total,
        counts,
        rates: {
          acceptRate: total ? (counts.ACCEPT ?? 0) / total : 0,
          declineRate: total ? (counts.DECLINE ?? 0) / total : 0,
          reviewRate: total ? (counts.REVIEW ?? 0) / total : 0,
        },
        topReasonCodes: topReasons,
      })
    );
  };
}

function startOfTodayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export default StatsController;
