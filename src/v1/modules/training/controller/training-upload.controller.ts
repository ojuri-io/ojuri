import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { TrainingUploadStatus } from "@shared/enums/training-upload-status.enum";
import TrainingUploadService from "../services/training-upload.service";
import { TrainingUpload } from "../model/training-upload.model";
import {
  CompleteUploadResponseDto,
  InitUploadRequestDto,
  InitUploadResponseDto,
  UploadStatusResponseDto,
} from "../dtos/training-upload.dto";

@injectable()
class TrainingUploadController {
  constructor(private readonly service: TrainingUploadService) {}

  init = async (
    req: FastifyRequest<{ Body: InitUploadRequestDto }>,
    res: FastifyReply,
  ): Promise<void> => {
    const { filename, expectedBytes, expectedSha256 } = req.body ?? ({} as InitUploadRequestDto);
    if (!filename || typeof filename !== "string") {
      res.code(httpStatus.BAD_REQUEST).send(ErrorResponse("filename is required"));
      return;
    }
    if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
      res.code(httpStatus.BAD_REQUEST).send(ErrorResponse("expectedBytes must be a positive integer"));
      return;
    }
    const tenantId = req.apiKey?.tenantId ?? req.auth?.tenantId ?? null;
    const createdBy = req.auth?.username ?? req.apiKey?.id ?? "unknown";
    const upload = await this.service.init({
      filename,
      expectedBytes: Number(expectedBytes),
      expectedSha256: expectedSha256 ?? null,
      tenantId,
      createdBy,
    });
    const body: InitUploadResponseDto = {
      uploadId: upload.id,
      chunkSize: upload.chunkSize,
      expiresAt: upload.expiresAt.toISOString(),
    };
    res.code(httpStatus.OK).send(SuccessResponse("Upload session created", body));
  };

  chunk = async (
    req: FastifyRequest<{ Params: { uploadId: string }; Querystring: { offset?: string } }>,
    res: FastifyReply,
  ): Promise<void> => {
    const offset = Number.parseInt(req.query.offset ?? "", 10);
    if (!Number.isFinite(offset) || offset < 0) {
      res.code(httpStatus.BAD_REQUEST).send(ErrorResponse("offset query parameter is required and must be non-negative"));
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      res.code(httpStatus.BAD_REQUEST).send(ErrorResponse("chunk body must be raw bytes (Content-Type: application/octet-stream)"));
      return;
    }
    const upload = await this.service.writeChunk({
      uploadId: req.params.uploadId,
      offset,
      bytes: body,
    });
    res.code(httpStatus.OK).send(SuccessResponse("Chunk received", toStatus(upload)));
  };

  complete = async (
    req: FastifyRequest<{
      Params: { uploadId: string };
      Body?: { transformSpec?: import("../services/training.types").TrainingTransformSpec | null };
    }>,
    res: FastifyReply,
  ): Promise<void> => {
    const createdBy = req.auth?.username ?? req.apiKey?.id ?? "unknown";
    const { uploadId, jobId } = await this.service.complete({
      uploadId: req.params.uploadId,
      createdBy,
      transformSpec: req.body?.transformSpec ?? null,
    });
    const upload = await this.service.getById(uploadId);
    const body: CompleteUploadResponseDto = {
      uploadId,
      jobId,
      source: `file://${(upload.filename || "labels.csv")}`,
    };
    res.code(httpStatus.OK).send(SuccessResponse("Upload assembled and queued", body));
  };

  status = async (
    req: FastifyRequest<{ Params: { uploadId: string } }>,
    res: FastifyReply,
  ): Promise<void> => {
    const upload = await this.service.getById(req.params.uploadId);
    res.send(SuccessResponse("Upload status", toStatus(upload)));
  };

  abandon = async (
    req: FastifyRequest<{ Params: { uploadId: string } }>,
    res: FastifyReply,
  ): Promise<void> => {
    await this.service.abandon(req.params.uploadId);
    res.code(httpStatus.OK).send(SuccessResponse("Upload abandoned", { uploadId: req.params.uploadId }));
  };
}

function toStatus(upload: TrainingUpload): UploadStatusResponseDto {
  return {
    uploadId: upload.id,
    filename: upload.filename,
    status: upload.status as TrainingUploadStatus,
    bytesReceived: Number(upload.bytesReceived),
    expectedBytes: Number(upload.expectedBytes),
    chunksReceived: upload.chunksReceived,
    jobId: upload.jobId,
  };
}

export default TrainingUploadController;
