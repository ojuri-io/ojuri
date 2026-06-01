import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import TrainingService from "../services/training.service";
import { CreateTrainingImportDto, TrainingImportJobResponseDto } from "../dtos/training-import.dto";
import { TrainingJob } from "../model/training-job.model";
import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";

@injectable()
class TrainingController {
  constructor(private readonly service: TrainingService) {}

  createImport = async (
    req: FastifyRequest<{ Body: CreateTrainingImportDto }>,
    res: FastifyReply,
  ): Promise<void> => {
    const source = req.body?.source?.trim();
    if (!source) {
      res.code(httpStatus.BAD_REQUEST).send(ErrorResponse("source is required"));
      return;
    }
    const tenantId = req.apiKey?.tenantId ?? req.auth?.tenantId ?? null;
    const createdBy = req.auth?.username ?? req.apiKey?.id ?? "unknown";
    const job = await this.service.enqueue({ source, tenantId, createdBy });
    res.code(httpStatus.OK).send(SuccessResponse("Training import queued", toResponse(job)));
  };

  getImport = async (
    req: FastifyRequest<{ Params: { jobId: string } }>,
    res: FastifyReply,
  ): Promise<void> => {
    const job = await this.service.getById(req.params.jobId);
    res.send(SuccessResponse("Training import status", toResponse(job)));
  };

  listImports = async (
    req: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
    res: FastifyReply,
  ): Promise<void> => {
    const limit = Number.parseInt(req.query.limit ?? "25", 10) || 25;
    const offset = Number.parseInt(req.query.offset ?? "0", 10) || 0;
    const { rows, total } = await this.service.list({ limit, offset });
    res.send(
      SuccessResponse("Training imports", {
        rows: rows.map(toResponse),
        total,
        limit,
        offset,
      }),
    );
  };

  promoteImport = async (
    req: FastifyRequest<{ Params: { jobId: string } }>,
    res: FastifyReply,
  ): Promise<void> => {
    const promotedBy = req.auth?.username ?? req.apiKey?.id ?? "unknown";
    const { promotedRows } = await this.service.promote(req.params.jobId, promotedBy);
    const job = await this.service.getById(req.params.jobId);
    res.send(
      SuccessResponse("Training import promoted to transactions", {
        ...toResponse(job),
        promotedRows,
      }),
    );
  };
}

function toResponse(job: TrainingJob): TrainingImportJobResponseDto {
  return {
    jobId: job.id,
    source: job.source,
    status: job.status as TrainingJobStatus,
    rowsRead: job.rowsRead,
    rowsStaged: job.rowsStaged,
    rowsRejected: job.rowsRejected,
    errors: job.errors,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    promotedAt: job.promotedAt ? job.promotedAt.toISOString() : null,
    promotedBy: job.promotedBy ?? null,
    promotedRows: job.promotedRows ?? null,
  };
}

export default TrainingController;
