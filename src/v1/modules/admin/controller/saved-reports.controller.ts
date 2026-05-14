import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import SavedReportsService, { DATA_SOURCE_COLUMNS } from "@shared/reports/saved-reports.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import {
  CreateSavedReportDto,
  RunSavedReportDto,
  UpdateSavedReportDto,
} from "../dtos/saved-report.dto";

const log = createServiceLogger("SavedReportsController");

@injectable()
class SavedReportsController {
  constructor(private readonly service: SavedReportsService) {}

  /**
   * Static catalogue describing the data sources the runner can hit
   * and which columns each one exposes. The UI uses this to populate
   * the column-picker — having it server-side keeps the column list
   * authoritative as we add data sources later.
   */
  catalogue = async (_req: FastifyRequest, res: FastifyReply) => {
    return res.send(
      SuccessResponse("Saved-report data-source catalogue", {
        sources: Object.entries(DATA_SOURCE_COLUMNS).map(([id, columns]) => ({
          id,
          columns,
        })),
      })
    );
  };

  list = async (req: FastifyRequest, res: FastifyReply) => {
    const tenantId = req.auth?.tenantId;
    const rows = await this.service.list(tenantId);
    return res.send(SuccessResponse("Saved reports", rows));
  };

  getById = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    res: FastifyReply
  ) => {
    const row = await this.service.getById(req.params.id);
    if (!row) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Saved report not found"));
    }
    return res.send(SuccessResponse("Saved report", row));
  };

  create = async (
    req: FastifyRequest<{ Body: CreateSavedReportDto }>,
    res: FastifyReply
  ) => {
    try {
      const row = await this.service.create({
        name: req.body.name,
        description: req.body.description,
        dataSource: req.body.dataSource || "audit",
        filters: req.body.filters || {},
        columns: req.body.columns || [],
        createdBy: req.auth?.username ?? null,
        tenantId: req.auth?.tenantId ?? null,
      });
      return res.code(httpStatus.CREATED).send(SuccessResponse("Saved report created", row));
    } catch (err) {
      const e = err as Error;
      log.error("create", "Failed to create saved report", { message: e?.message });
      return res
        .code(httpStatus.INTERNAL_SERVER_ERROR)
        .send(ErrorResponse(`Failed to create saved report: ${e?.message || "unknown"}`));
    }
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string }; Body: UpdateSavedReportDto }>,
    res: FastifyReply
  ) => {
    const row = await this.service.update(req.params.id, req.body);
    if (!row) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Saved report not found"));
    }
    return res.send(SuccessResponse("Saved report updated", row));
  };

  delete = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    res: FastifyReply
  ) => {
    const ok = await this.service.delete(req.params.id);
    if (!ok) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Saved report not found"));
    }
    return res.send(SuccessResponse("Saved report deleted"));
  };

  /**
   * Execute a saved report. Pagination via `limit` / `offset` query
   * params; ad-hoc filter overrides via POST body so the UI can layer
   * a runtime date range on a saved row without rewriting it.
   */
  run = async (
    req: FastifyRequest<{
      Params: { id: string };
      Querystring: { limit?: string; offset?: string };
      Body?: RunSavedReportDto;
    }>,
    res: FastifyReply
  ) => {
    const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined;
    const offset = req.query.offset ? Number.parseInt(req.query.offset, 10) : undefined;
    const result = await this.service.run(req.params.id, {
      limit,
      offset,
      override: req.body?.override,
    });
    if (!result) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Saved report not found"));
    }
    return res.send(SuccessResponse("Saved report run", result));
  };

  /**
   * Stream the full result set as CSV or JSON. Caps at 10k rows so a
   * runaway filter can't pin the connection — the UI surfaces the
   * cap as a tooltip on the export button.
   */
  export = async (
    req: FastifyRequest<{
      Params: { id: string };
      Querystring: { format?: string; limit?: string };
      Body?: RunSavedReportDto;
    }>,
    res: FastifyReply
  ) => {
    const format = (req.query.format || "csv").toLowerCase();
    const cap = 10_000;
    const limit = Math.min(
      req.query.limit ? Number.parseInt(req.query.limit, 10) : cap,
      cap
    );
    const result = await this.service.run(req.params.id, {
      limit,
      offset: 0,
      override: req.body?.override,
    });
    if (!result) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Saved report not found"));
    }

    if (format === "json") {
      res.header("content-type", "application/json");
      res.header(
        "content-disposition",
        `attachment; filename="saved-report-${req.params.id}.json"`
      );
      return res.send(JSON.stringify({ rows: result.rows, total: result.total }, null, 2));
    }

    // Default to CSV. Build it server-side with cell escaping per RFC4180.
    const csv = toCsv(result.columns, result.rows);
    res.header("content-type", "text/csv; charset=utf-8");
    res.header(
      "content-disposition",
      `attachment; filename="saved-report-${req.params.id}.csv"`
    );
    return res.send(csv);
  };
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const head = columns.join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(","));
  return [head, ...body].join("\n");
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "string") {
    s = v;
  } else if (v instanceof Date) {
    // Date → ISO string directly. JSON.stringify(date) wraps the ISO
    // value in its own quotes, which then triggers CSV escaping and
    // produces `"""...Z"""` triple-quoted cells. Sidestep entirely.
    s = v.toISOString();
  } else if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export default SavedReportsController;
