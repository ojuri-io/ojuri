import { singleton } from "tsyringe";
import DecisionAuditService from "@shared/audit/decision-audit.service";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import SavedReportRepo from "./repositories/saved-report.repo";
import { SavedReport } from "./model/saved-report.model";

const log = createServiceLogger("SavedReportsService");

export type DataSource = "audit";

export interface SavedReportFilters {
  from?: string;
  to?: string;
  decision?: string[];
  modelVersion?: string;
  reasonCodes?: string[];
  search?: string;
  overridden?: boolean;
  pending?: boolean;
  tenantId?: string;
}

export interface CreateSavedReportInput {
  name: string;
  description?: string;
  dataSource: DataSource;
  filters: SavedReportFilters;
  columns: string[];
  createdBy?: string | null;
  tenantId?: string | null;
}

export interface UpdateSavedReportInput {
  name?: string;
  description?: string | null;
  dataSource?: DataSource;
  filters?: SavedReportFilters;
  columns?: string[];
}

export interface RunOptions {
  limit?: number;
  offset?: number;
  // Caller-provided filter overrides — merged on top of the saved
  // filters so the UI can apply ad-hoc tweaks (e.g. a date range) at
  // run time without rewriting the saved row.
  override?: Partial<SavedReportFilters>;
}

export interface RunResult {
  rows: Record<string, unknown>[];
  total: number;
  columns: string[];
}

/**
 * Catalogue of fields each data source can project. Columns the user
 * picks must be a subset of these — anything outside is silently
 * stripped so a malformed save can't crash the runner.
 */
export const DATA_SOURCE_COLUMNS: Record<DataSource, string[]> = {
  audit: [
    "createdAt",
    "transactionId",
    "tenantId",
    "senderId",
    "receiverId",
    "amount",
    "transactionType",
    "segment",
    "championModelVersion",
    "shadowModelVersion",
    "championScore",
    "shadowScore",
    "threshold",
    "mlDecision",
    "finalDecision",
    "decisionSource",
    "ruleId",
    "ruleName",
    "ruleStage",
    "reasonCodes",
    "reviewedBy",
    "reviewedAt",
    "overrideDecision",
    "overrideReason",
    "latencyMs",
  ],
};

@singleton()
class SavedReportsService {
  constructor(
    private readonly repo: SavedReportRepo,
    private readonly audit: DecisionAuditService
  ) {}

  async list(tenantId?: string | null): Promise<SavedReport[]> {
    return this.repo.listAll(tenantId ?? undefined);
  }

  async getById(id: string): Promise<SavedReport | undefined> {
    return this.repo.findById(id);
  }

  async create(input: CreateSavedReportInput): Promise<SavedReport> {
    const columns = sanitiseColumns(input.dataSource, input.columns);
    return this.repo.save({
      name: input.name,
      description: input.description ?? null,
      dataSource: input.dataSource,
      filters: (input.filters ?? {}) as Record<string, unknown>,
      columns,
      createdBy: input.createdBy ?? null,
      tenantId: input.tenantId ?? null,
    });
  }

  async update(id: string, patch: UpdateSavedReportInput): Promise<SavedReport | undefined> {
    const existing = await this.repo.findById(id);
    if (!existing) return undefined;
    const dataSource = (patch.dataSource ?? existing.dataSource) as DataSource;
    const next: Partial<SavedReport> = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.dataSource !== undefined) next.dataSource = patch.dataSource;
    if (patch.filters !== undefined) {
      next.filters = (patch.filters ?? {}) as Record<string, unknown>;
    }
    if (patch.columns !== undefined) {
      next.columns = sanitiseColumns(dataSource, patch.columns);
    }
    return this.repo.patchById(id, next);
  }

  async delete(id: string): Promise<boolean> {
    const n = await this.repo.deleteById(id);
    return n > 0;
  }

  /**
   * Execute a saved report against its data source. Returns rows
   * projected to the saved column set and the total matching count
   * for pagination. `options.override` lets the caller layer ad-hoc
   * filters (typically a date range) on top of the saved ones — the
   * saved row itself is left untouched.
   */
  async run(id: string, options: RunOptions = {}): Promise<RunResult | undefined> {
    const row = await this.repo.findById(id);
    if (!row) return undefined;

    const dataSource = row.dataSource as DataSource;
    const merged = { ...(row.filters as SavedReportFilters), ...(options.override ?? {}) };
    const columns = row.columns?.length
      ? sanitiseColumns(dataSource, row.columns)
      : DATA_SOURCE_COLUMNS[dataSource];

    if (dataSource === "audit") {
      const res = await this.audit.listFiltered({
        from: merged.from,
        to: merged.to,
        decision: merged.decision,
        modelVersion: merged.modelVersion,
        reasonCodes: merged.reasonCodes,
        search: merged.search,
        overridden: merged.overridden,
        pending: merged.pending,
        tenantId: merged.tenantId,
        limit: options.limit ?? 100,
        offset: options.offset ?? 0,
      });
      const rows = res.rows.map((r) => projectAuditRow(r as unknown as Record<string, unknown>, columns));
      return { rows, total: res.total, columns };
    }

    log.warn("run", "Unknown dataSource — returning empty", { dataSource });
    return { rows: [], total: 0, columns };
  }
}

function sanitiseColumns(source: DataSource, cols: string[] | undefined): string[] {
  const allowed = DATA_SOURCE_COLUMNS[source] || [];
  if (!cols || cols.length === 0) return allowed;
  const set = new Set(allowed);
  return cols.filter((c) => set.has(c));
}

function projectAuditRow(r: Record<string, unknown>, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    const v = r[c];
    if (v === undefined) {
      out[c] = null;
      continue;
    }
    // Postgres numeric → string; normalise the columns the audit
    // controller normally coerces to Number so CSV cells stay numeric.
    if (
      (c === "amount" ||
        c === "championScore" ||
        c === "shadowScore" ||
        c === "threshold" ||
        c === "latencyMs") &&
      v !== null
    ) {
      const n = Number(v);
      out[c] = Number.isFinite(n) ? n : null;
    } else {
      out[c] = v;
    }
  }
  return out;
}

export default SavedReportsService;
