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
  };
}

export default TrainingController;
