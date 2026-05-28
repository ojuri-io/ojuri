import { injectable } from "tsyringe";
import { BaseRepository } from "../../repositories/base.repo";
import { DecisionAudit, IDecisionAudit } from "../model/decision-audit.model";

/**
 * The slice of `transactions` we surface to the operator on the
 * detail page. Keep this list to fields a reviewer reads at a glance —
 * scoring-relevant numerics live in `featuresSnapshot` on the audit
 * row itself.
 */
export interface TransactionContext {
  customerAccountName: string | null;
  beneficiaryAccountName: string | null;
  customerDob: string | null;
  customerNationality: string | null;
  customerType: string | null;
  customerIdType: string | null;
  accountAgeDays: number | null;
  isAuthenticated: boolean | null;
  channel: string | null;
  currency: string | null;
  isInflow: boolean | null;
  isRecurring: boolean | null;
  walletBalance: number | null;
  customerLatitude: number | null;
  customerLongitude: number | null;
  transactionCountry: string | null;
  destinationCountry: string | null;
  ipCountry: string | null;
  transactionLat: number | null;
  transactionLng: number | null;
  ipIsVpn: boolean | null;
  deviceIsTrusted: boolean | null;
  deviceType: string | null;
  sessionToTxnSeconds: number | null;
  deviceFingerprint: Record<string, unknown> | null;
  agentId: string | null;
  recipientNationality: string | null;
  recipientIdType: string | null;
  customerFi: string | null;
  recipientFi: string | null;
  requestContext: Record<string, unknown> | null;
}

function pickNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pickStr(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}
function pickBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : v == null ? null : Boolean(v);
}
function pickObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toContext(t: Record<string, unknown>): TransactionContext {
  return {
    customerAccountName: pickStr(t.customerAccountName),
    beneficiaryAccountName: pickStr(t.beneficiaryAccountName),
    customerDob: pickStr(t.customerDob),
    customerNationality: pickStr(t.customerNationality),
    customerType: pickStr(t.customerType),
    customerIdType: pickStr(t.customerIdType),
    accountAgeDays: pickNum(t.accountAgeDays),
    isAuthenticated: pickBool(t.isAuthenticated),
    channel: pickStr(t.channel),
    currency: pickStr(t.currency),
    isInflow: pickBool(t.isInflow),
    isRecurring: pickBool(t.isRecurring),
    walletBalance: pickNum(t.walletBalance),
    customerLatitude: pickNum(t.customerLatitude),
    customerLongitude: pickNum(t.customerLongitude),
    transactionCountry: pickStr(t.transactionCountry),
    destinationCountry: pickStr(t.destinationCountry),
    ipCountry: pickStr(t.ipCountry),
    transactionLat: pickNum(t.transactionLat),
    transactionLng: pickNum(t.transactionLng),
    ipIsVpn: pickBool(t.ipIsVpn),
    deviceIsTrusted: pickBool(t.deviceIsTrusted),
    deviceType: pickStr(t.deviceType),
    sessionToTxnSeconds: pickNum(t.sessionToTxnSeconds),
    deviceFingerprint: pickObj(t.deviceFingerprint),
    agentId: pickStr(t.agentId),
    recipientNationality: pickStr(t.recipientNationality),
    recipientIdType: pickStr(t.recipientIdType),
    customerFi: pickStr(t.customerFi),
    recipientFi: pickStr(t.recipientFi),
    requestContext: pickObj(t.requestContext),
  };
}

@injectable()
class DecisionAuditRepo extends BaseRepository<IDecisionAudit, DecisionAudit> {
  constructor() {
    super(DecisionAudit);
  }

  /**
   * Look up the latest audit row for a transaction AND fold in the
   * contextual payload that PAA persists into `transactions`
   * (customer / recipient identity, channel, currency, geography,
   * device, agent, FI route, `requestContext`, display account names).
   *
   * LEFT JOIN — the audit row exists the moment RDA scores the
   * request; PAA flushes the `transactions` row asynchronously
   * (~ms–seconds later), so for very fresh transactions the join
   * column will be NULL. Callers detect that as `row.context == null`
   * and the UI shows the empty-context skeleton until the next reload.
   */
  async findLatestByTransactionId(transactionId: string): Promise<(DecisionAudit & { context?: TransactionContext | null }) | undefined> {
    const knex = DecisionAudit.knex();
    const row = (await knex
      .from({ a: DecisionAudit.tableName })
      .leftJoin({ t: "transactions" }, "t.transactionId", "a.transactionId")
      .where("a.transactionId", transactionId)
      .orderBy("a.createdAt", "desc")
      .first(
        knex.raw('row_to_json(a) as audit'),
        knex.raw('row_to_json(t) as txn')
      )) as { audit: DecisionAudit; txn: Record<string, unknown> | null } | undefined;
    if (!row || !row.audit) return undefined;
    return { ...row.audit, context: row.txn ? toContext(row.txn) : null } as DecisionAudit & {
      context?: TransactionContext | null;
    };
  }


  async applyOverride(input: {
    auditId: string;
    reviewer: string;
    decision: string;
    reason: string | null;
  }): Promise<DecisionAudit | undefined> {
    await DecisionAudit.query().where({ id: input.auditId }).patch({
      reviewedBy: input.reviewer,
      reviewedAt: new Date(),
      overrideDecision: input.decision,
      overrideReason: input.reason,
    });
    return DecisionAudit.query().findById(input.auditId);
  }

  /**
   * Propagate a verified verdict to `transactions.groundTruthFraud`.
   *
   * Called from `DecisionAuditService.override()` after a reviewer
   * confirms or clears a decision. The same hook can be reused by a
   * future chargeback-ingestion writer — `source` distinguishes the
   * provenance.
   *
   * `affected` is 0 when no matching `transactions` row exists yet
   * (e.g. PAA hadn't flushed when the override fired); the caller
   * logs at WARN but doesn't fail the override.
   */
  async writeGroundTruth(input: {
    transactionId: string;
    groundTruthFraud: boolean;
    source: string;
    recordedBy: string;
  }): Promise<number> {
    const knex = DecisionAudit.knex();
    const affected = await knex("transactions")
      .where({ transactionId: input.transactionId })
      .update({
        groundTruthFraud: input.groundTruthFraud,
        groundTruthSource: input.source,
        groundTruthRecordedAt: knex.fn.now(),
        groundTruthRecordedBy: input.recordedBy,
      });
    return Number(affected) || 0;
  }

  async listReviewQueue(limit: number): Promise<DecisionAudit[]> {
    return DecisionAudit.query()
      .where({ finalDecision: "DECLINE" })
      .whereNull("reviewedAt")
      .orderBy("createdAt", "desc")
      .limit(limit);
  }

  /**
   * Paginated variant of `listReviewQueue` — same filter, but returns
   * `{ rows, total }` so the UI can render real "page X of Y" chrome.
   * Backed by a single `clone()` so the count + slice come from the
   * same query plan and stay consistent across overrides racing with
   * the fetch.
   */
  async listReviewQueuePaginated(opts: {
    limit: number;
    offset: number;
    order?: "newest" | "oldest";
    search?: string;
  }): Promise<{
    rows: DecisionAudit[];
    total: number;
    oldestPendingAt: Date | null;
    totalPendingAmount: number;
  }> {
    const baseQuery = DecisionAudit.query()
      .where({ finalDecision: "DECLINE" })
      .whereNull("reviewedAt");

    // ILIKE %term% across the identifier columns the analyst sees in
    // the list — same shape as the audit-log search so the muscle
    // memory carries over.
    if (opts.search && opts.search.trim()) {
      const s = `%${opts.search.trim()}%`;
      baseQuery.where((b) => {
        b.where("transactionId", "ilike", s)
          .orWhere("senderId", "ilike", s)
          .orWhere("receiverId", "ilike", s);
      });
    }

    const total = (await baseQuery.clone().resultSize()) as unknown as number;

    // Aggregate fields the dashboard's "Things to do" tile reads —
    // computing them here keeps the call to a single round-trip per
    // poll rather than firing a sibling /stats endpoint. Both are NULL
    // when the queue is empty; the formatter handles that case.
    const aggRow = total > 0
      ? ((await baseQuery
          .clone()
          .clearOrder()
          .select(
            DecisionAudit.raw('MIN("createdAt") as "oldestPendingAt"'),
            DecisionAudit.raw('SUM(amount) as "totalPendingAmount"'),
          )
          .first()) as unknown as { oldestPendingAt: Date | null; totalPendingAmount: string | null } | undefined)
      : undefined;

    const rows = await baseQuery
      .clone()
      .orderBy("createdAt", opts.order === "oldest" ? "asc" : "desc")
      .limit(Math.min(Math.max(opts.limit, 1), 200))
      .offset(Math.max(opts.offset, 0));

    return {
      rows,
      total: Number(total) || 0,
      oldestPendingAt: aggRow?.oldestPendingAt ? new Date(aggRow.oldestPendingAt) : null,
      totalPendingAmount: aggRow?.totalPendingAmount != null ? Number(aggRow.totalPendingAmount) : 0,
    };
  }

  /**
   * Decision counts grouped by `finalDecision` over a time window.
   * The Dashboard's "Today's decisions" tile and Metrics page top
   * KPIs both read this.
   */
  async countByDecisionSince(since: Date): Promise<Record<string, number>> {
    const rows = (await DecisionAudit.query()
      .where("createdAt", ">=", since)
      .groupBy("finalDecision")
      .select("finalDecision")
      .count({ n: "*" })) as unknown as Array<{ finalDecision: string; n: string }>;
    const out: Record<string, number> = { ACCEPT: 0, DECLINE: 0, REVIEW: 0 };
    for (const r of rows) out[r.finalDecision] = Number(r.n);
    return out;
  }

  /**
   * Top reason codes across DECLINE rows since `since`, ordered by
   * frequency. The Metrics page's "Top reason codes" bar chart reads
   * this. Uses Postgres jsonb_array_elements to fan out the `reasonCodes`
   * array stored on each row.
   */
  async topReasonCodesSince(since: Date, limit = 10): Promise<Array<{ code: string; count: number }>> {
    const knex = DecisionAudit.knex();
    const rows = (await knex
      .from(DecisionAudit.tableName)
      .where("createdAt", ">=", since)
      .andWhere("finalDecision", "DECLINE")
      .crossJoin(knex.raw(`jsonb_array_elements(coalesce("reasonCodes", '[]'::jsonb)) AS elem`))
      .groupBy(knex.raw(`elem->>'code'`))
      .orderBy("count", "desc")
      .limit(limit)
      .select(knex.raw(`elem->>'code' as code`), knex.raw(`count(*)::int as count`))) as unknown as Array<{
      code: string;
      count: number;
    }>;
    return rows;
  }

  /**
   * Most recent audit rows newer than `since`. Used by the Live
   * decisions polling endpoint. Caller can request `limit` rows; we
   * cap aggressively because this fires on a ~1 s loop.
   *
   * **Precision note.** Postgres `timestamp` columns hold microseconds,
   * but the API serializes `createdAt` down to milliseconds. Naively
   * doing `"createdAt" > $1::timestamptz` would re-return the exact
   * newest row on every poll — because `2026-05-14T00:00.929Z` (what
   * the client sends back) is still less than the stored
   * `2026-05-14T00:00.929187Z`. We `date_trunc` both sides to
   * milliseconds so the cursor advances cleanly.
   */
  async listRecentSince(since: Date | null, limit: number): Promise<DecisionAudit[]> {
    const knex = DecisionAudit.knex();
    const q = DecisionAudit.query().orderBy("createdAt", "desc").limit(Math.min(Math.max(limit, 1), 200));
    if (since) {
      q.where(
        knex.raw(`date_trunc('milliseconds', "createdAt") > date_trunc('milliseconds', ?::timestamptz)`, [
          since.toISOString(),
        ])
      );
    }
    return q;
  }

  /**
   * Audit rows that share a sender or receiver with the supplied row.
   * Excludes the row itself. Used to populate the "Similar cases"
   * panel on the review queue.
   */
  async listSimilar(auditId: string, limit: number): Promise<DecisionAudit[]> {
    const seed = await DecisionAudit.query().findById(auditId);
    if (!seed) return [];
    return DecisionAudit.query()
      .whereNot({ id: auditId })
      .andWhere((b) => {
        b.where({ senderId: seed.senderId }).orWhere({ receiverId: seed.receiverId });
      })
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 20));
  }

  /**
   * Champion latency percentiles over a time window. Used by the
   * Dashboard's Champion model tile and the Metrics latency chart's
   * "current" summary. Returns null fields when there's no data.
   */
  async championLatencyPercentiles(since: Date): Promise<{ p50: number | null; p95: number | null; p99: number | null; total: number }> {
    const knex = DecisionAudit.knex();
    const [row] = (await knex
      .from(DecisionAudit.tableName)
      .where("createdAt", ">=", since)
      .whereNotNull("latencyMs")
      .select(
        knex.raw(
          `percentile_cont(0.5)  within group (order by "latencyMs") as p50,
           percentile_cont(0.95) within group (order by "latencyMs") as p95,
           percentile_cont(0.99) within group (order by "latencyMs") as p99,
           count(*)::int as total`
        )
      )) as unknown as Array<{ p50: number | null; p95: number | null; p99: number | null; total: number }>;
    return {
      p50: row?.p50 == null ? null : Number(row.p50),
      p95: row?.p95 == null ? null : Number(row.p95),
      p99: row?.p99 == null ? null : Number(row.p99),
      total: row?.total ?? 0,
    };
  }

  /**
   * Bucketed latency percentiles. Produces a timeseries the Metrics
   * latency chart renders. Each bucket spans `bucketMinutes`.
   */
  async latencyBuckets(from: Date, to: Date, bucketMinutes: number): Promise<Array<{ ts: string; p50: number; p95: number; p99: number; count: number }>> {
    const knex = DecisionAudit.knex();
    const intervalSec = Math.max(60, Math.floor(bucketMinutes * 60));
    // The bucket expression must be **textually identical** in SELECT,
    // GROUP BY, and ORDER BY or Postgres treats them as distinct expressions
    // and raises `42803 column ... must appear in the GROUP BY clause`.
    // Using positional bindings via knex re-numbers parameters in each
    // clause ($1/$2, $4/$5, $6/$7), tripping that check. The integer here
    // is server-validated to an int ≥ 60, so inlining is safe.
    const bucketExpr = `to_timestamp(floor(extract(epoch from "createdAt") / ${intervalSec}) * ${intervalSec})`;
    const rows = (await knex
      .from(DecisionAudit.tableName)
      .where("createdAt", ">=", from)
      .andWhere("createdAt", "<", to)
      .whereNotNull("latencyMs")
      .groupByRaw(bucketExpr)
      .orderByRaw(bucketExpr)
      .select(
        knex.raw(
          `${bucketExpr} as ts,
           percentile_cont(0.5)  within group (order by "latencyMs") as p50,
           percentile_cont(0.95) within group (order by "latencyMs") as p95,
           percentile_cont(0.99) within group (order by "latencyMs") as p99,
           count(*)::int as count`
        )
      )) as unknown as Array<{ ts: Date; p50: number | string; p95: number | string; p99: number | string; count: number }>;
    return rows.map((r) => ({
      ts: new Date(r.ts).toISOString(),
      p50: Number(r.p50),
      p95: Number(r.p95),
      p99: Number(r.p99),
      count: r.count,
    }));
  }

  /**
   * Count of overrides (rows with reviewedAt set) since `since`.
   * Used for the Metrics page override-rate KPI.
   */
  async overrideCountSince(since: Date): Promise<number> {
    const knex = DecisionAudit.knex();
    const [row] = (await knex
      .from(DecisionAudit.tableName)
      .where("createdAt", ">=", since)
      .whereNotNull("reviewedAt")
      .count<{ n: string }[]>("* as n")) as Array<{ n: string }>;
    return Number(row?.n || 0);
  }

  /**
   * Bucketed decision counts (and a parallel decline + override count)
   * for the Metrics page sparklines. Each bucket spans `bucketSeconds`.
   */
  async decisionBuckets(from: Date, bucketSeconds: number, buckets: number): Promise<Array<{ ts: string; total: number; declines: number; overrides: number }>> {
    const knex = DecisionAudit.knex();
    const stepSec = Math.max(60, Math.floor(bucketSeconds));
    // See latencyBuckets() for why the bucket expression must be inlined
    // rather than parameter-bound across SELECT / GROUP BY / ORDER BY.
    const bucketExpr = `to_timestamp(floor(extract(epoch from "createdAt") / ${stepSec}) * ${stepSec})`;
    const rows = (await knex
      .from(DecisionAudit.tableName)
      .where("createdAt", ">=", from)
      .groupByRaw(bucketExpr)
      .orderByRaw(bucketExpr)
      .select(
        knex.raw(
          `${bucketExpr} as ts,
           count(*)::int as total,
           count(*) filter (where "finalDecision" = 'DECLINE')::int as declines,
           count(*) filter (where "reviewedAt" is not null)::int as overrides`
        )
      )) as unknown as Array<{ ts: Date; total: number; declines: number; overrides: number }>;
    // Trim to most recent N buckets — defensive cap.
    return rows.slice(-buckets).map((r) => ({
      ts: new Date(r.ts).toISOString(),
      total: r.total,
      declines: r.declines,
      overrides: r.overrides,
    }));
  }

  /**
   * Champion / shadow comparison summary used by the Model registry
   * page. `agreement` is the share of rows where ML and shadow agree
   * (both >= threshold or both < threshold). `netDeclineDelta` is the
   * shadow-vs-champion decline-count delta. `scoreBuckets` is a 20-bin
   * histogram of each model's score column.
   */
  async modelComparison(
    championVersion: string,
    shadowVersion: string,
    from: Date,
    to: Date
  ): Promise<{
    replayed: number;
    agreement: number;
    netDeclineDelta: number;
    championBuckets: number[];
    shadowBuckets: number[];
  }> {
    const knex = DecisionAudit.knex();
    const base = knex
      .from(DecisionAudit.tableName)
      .where("createdAt", ">=", from)
      .andWhere("createdAt", "<", to)
      .andWhere("championModelVersion", championVersion)
      .andWhere("shadowModelVersion", shadowVersion)
      .whereNotNull("championScore")
      .whereNotNull("shadowScore");

    const [agg] = (await base
      .clone()
      .select(
        knex.raw(
          `count(*)::int as replayed,
           count(*) filter (
             where (("championScore" >= "threshold") = ("shadowScore" >= "threshold"))
           )::int as agree,
           count(*) filter (where "shadowScore" >= "threshold")::int as shadow_declines,
           count(*) filter (where "championScore" >= "threshold")::int as champ_declines`
        )
      )) as unknown as Array<{
      replayed: number;
      agree: number;
      shadow_declines: number;
      champ_declines: number;
    }>;

    // 20-bucket histograms via floor(score * 20) so 0.0..0.05 maps to 0,
    // 0.95..1.0 maps to 19. width_bucket would be cleaner but we want
    // closed-on-left semantics that match the dashboard's renderer.
    const champBuckets: number[] = new Array(20).fill(0);
    const shadowBuckets: number[] = new Array(20).fill(0);

    const champRows = (await base
      .clone()
      .groupByRaw(`least(19, greatest(0, floor("championScore" * 20)))`)
      .select(
        knex.raw(`least(19, greatest(0, floor("championScore" * 20)))::int as bucket`),
        knex.raw(`count(*)::int as n`)
      )) as unknown as Array<{ bucket: number; n: number }>;
    for (const r of champRows) champBuckets[r.bucket] = r.n;

    const shadowRows = (await base
      .clone()
      .groupByRaw(`least(19, greatest(0, floor("shadowScore" * 20)))`)
      .select(
        knex.raw(`least(19, greatest(0, floor("shadowScore" * 20)))::int as bucket`),
        knex.raw(`count(*)::int as n`)
      )) as unknown as Array<{ bucket: number; n: number }>;
    for (const r of shadowRows) shadowBuckets[r.bucket] = r.n;

    return {
      replayed: agg?.replayed ?? 0,
      agreement: agg && agg.replayed > 0 ? agg.agree / agg.replayed : 0,
      netDeclineDelta: agg ? agg.shadow_declines - agg.champ_declines : 0,
      championBuckets: champBuckets,
      shadowBuckets,
    };
  }

  /**
   * Filtered audit/transactions list. The Audit log and Transactions
   * pages both read the same underlying table — they just paint it
   * differently. Filters are AND-ed; empty filters return everything
   * (paginated). Returns `[rows, total]` so the UI can render
   * "Showing 1–N of M".
   */
  async listFiltered(opts: AuditListFilters): Promise<{ rows: DecisionAudit[]; total: number }> {
    const baseQuery = DecisionAudit.query();
    applyFilters(baseQuery, opts);

    const totalRow = (await baseQuery
      .clone()
      .clearOrder()
      .resultSize()) as unknown as number;

    const rows = await baseQuery
      .clone()
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 500))
      .offset(opts.offset ?? 0);

    return { rows, total: totalRow };
  }
}

export interface AuditListFilters {
  from?: Date | string;
  to?: Date | string;
  decision?: string[]; // ACCEPT, DECLINE, REVIEW
  modelVersion?: string;
  reasonCodes?: string[]; // any-of match against the JSONB array
  search?: string; // transactionId / senderId / receiverId substring
  hasFia?: boolean; // only rows with an investigationReports entry (left as no-op until joined)
  overridden?: boolean;
  pending?: boolean; // unreviewed DECLINEs
  tenantId?: string;
  limit?: number;
  offset?: number;
}

function applyFilters(query: ReturnType<typeof DecisionAudit.query>, f: AuditListFilters) {
  if (f.from) query.where("createdAt", ">=", new Date(f.from));
  if (f.to) query.where("createdAt", "<=", new Date(f.to));
  if (f.decision && f.decision.length > 0) query.whereIn("finalDecision", f.decision);
  if (f.modelVersion) query.where({ championModelVersion: f.modelVersion });
  if (f.tenantId) query.where({ tenantId: f.tenantId });
  if (f.overridden) query.whereNotNull("overrideDecision");
  if (f.pending) query.where({ finalDecision: "DECLINE" }).whereNull("reviewedAt");
  if (f.search) {
    const s = `%${f.search}%`;
    query.where((b) => {
      b.where("transactionId", "ilike", s)
        .orWhere("senderId", "ilike", s)
        .orWhere("receiverId", "ilike", s);
    });
  }
  if (f.reasonCodes && f.reasonCodes.length > 0) {
    // jsonb array of {code, description, ...}. Match if ANY element's
    // `code` is in the requested set. Uses Postgres's jsonb `?|` "has
    // any of these keys" operator after extracting codes.
    const codes = f.reasonCodes;
    query.whereRaw(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce("reasonCodes", '[]'::jsonb)) elem WHERE elem->>'code' = ANY(?))`,
      [codes]
    );
  }
}

export default DecisionAuditRepo;
