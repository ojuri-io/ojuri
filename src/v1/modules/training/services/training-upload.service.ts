import { promises as fs, createReadStream, createWriteStream } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { injectable } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { TrainingUploadStatus } from "@shared/enums/training-upload-status.enum";
import TrainingUploadNotFoundError from "@shared/error/training-upload-not-found.error";
import TrainingUploadOffsetMismatchError from "@shared/error/training-upload-offset-mismatch.error";
import TrainingUploadSizeExceededError from "@shared/error/training-upload-size-exceeded.error";
import TrainingService from "./training.service";
import TrainingUploadRepo from "../repositories/training-upload.repo";
import TrainingUploadFactory from "../factories/training-upload.factory";
import { TrainingUpload } from "../model/training-upload.model";
import {
  ChunkWriteInput,
  CompleteUploadInput,
  CompleteUploadResult,
  InitUploadInput,
} from "./training-upload.types";

const log = createServiceLogger("TrainingUploadService");

const UPLOAD_ROOT = process.env.TRAINING_UPLOADS_DIR || "/app/data/training-uploads";
export const CHUNK_SIZE = Number(process.env.TRAINING_UPLOAD_CHUNK_SIZE) || 5 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Number(process.env.TRAINING_UPLOAD_MAX_BYTES) || 5 * 1024 * 1024 * 1024;

@injectable()
class TrainingUploadService {
  constructor(
    private readonly repo: TrainingUploadRepo,
    private readonly trainingService: TrainingService,
  ) {}

  async init(input: InitUploadInput): Promise<TrainingUpload> {
    if (input.expectedBytes <= 0) {
      throw new TrainingUploadSizeExceededError(MAX_UPLOAD_BYTES);
    }
    if (input.expectedBytes > MAX_UPLOAD_BYTES) {
      throw new TrainingUploadSizeExceededError(MAX_UPLOAD_BYTES);
    }
    const session = TrainingUploadFactory.createSession(input, CHUNK_SIZE);
    const saved = await this.repo.save(session);
    await fs.mkdir(this.chunkDirFor(saved.id), { recursive: true });
    return saved;
  }

  async getById(id: string): Promise<TrainingUpload> {
    const row = await this.repo.findByIdOrNull(id);
    if (!row) throw new TrainingUploadNotFoundError(id);
    return row;
  }

  async writeChunk(input: ChunkWriteInput): Promise<TrainingUpload> {
    const upload = await this.getById(input.uploadId);
    if (upload.status !== TrainingUploadStatus.IN_PROGRESS) {
      throw new TrainingUploadOffsetMismatchError(Number(upload.bytesReceived), input.offset);
    }
    const expectedOffset = Number(upload.bytesReceived);
    if (input.offset !== expectedOffset) {
      throw new TrainingUploadOffsetMismatchError(expectedOffset, input.offset);
    }
    const newBytes = expectedOffset + input.bytes.length;
    if (newBytes > Number(upload.expectedBytes)) {
      throw new TrainingUploadSizeExceededError(Number(upload.expectedBytes));
    }
    const chunkPath = this.chunkPathFor(upload.id, input.offset);
    await fs.writeFile(chunkPath, input.bytes);
    await this.repo.recordChunkAppend(upload.id, newBytes);
    return this.getById(upload.id);
  }

  async complete(input: CompleteUploadInput): Promise<CompleteUploadResult> {
    const upload = await this.getById(input.uploadId);
    if (upload.status !== TrainingUploadStatus.IN_PROGRESS) {
      return {
        uploadId: input.uploadId,
        jobId: upload.jobId ?? "",
        filePath: this.assembledPathFor(upload),
      };
    }
    const expectedBytes = Number(upload.expectedBytes);
    const bytesReceived = Number(upload.bytesReceived);
    if (bytesReceived !== expectedBytes) {
      throw new TrainingUploadOffsetMismatchError(expectedBytes, bytesReceived);
    }

    const assembledPath = this.assembledPathFor(upload);
    const sha256 = await this.assembleAndHash(upload.id, assembledPath);

    if (upload.expectedSha256 && upload.expectedSha256.toLowerCase() !== sha256) {
      await fs.rm(assembledPath, { force: true });
      throw new TrainingUploadOffsetMismatchError(expectedBytes, -1);
    }

    await fs.rm(this.chunkDirFor(upload.id), { recursive: true, force: true });

    const job = await this.trainingService.enqueue({
      source: `file://${assembledPath}`,
      tenantId: upload.tenantId,
      createdBy: input.createdBy,
      transformSpec: input.transformSpec ?? null,
    });
    await this.repo.markComplete(upload.id, job.id);

    log.success("complete", "training upload assembled and queued", {
      uploadId: upload.id,
      jobId: job.id,
      filename: upload.filename,
      bytes: expectedBytes,
    });
    return { uploadId: upload.id, jobId: job.id, filePath: assembledPath };
  }

  async abandon(uploadId: string): Promise<void> {
    const upload = await this.getById(uploadId);
    if (upload.status !== TrainingUploadStatus.IN_PROGRESS) return;
    await fs.rm(this.chunkDirFor(upload.id), { recursive: true, force: true });
    await this.repo.markAbandoned(upload.id);
  }

  private chunkDirFor(uploadId: string): string {
    return join(UPLOAD_ROOT, "chunks", uploadId);
  }

  private chunkPathFor(uploadId: string, offset: number): string {
    return join(this.chunkDirFor(uploadId), `chunk-${String(offset).padStart(16, "0")}.bin`);
  }

  private assembledPathFor(upload: TrainingUpload): string {
    const safeName = upload.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(UPLOAD_ROOT, `${upload.id}-${safeName}`);
  }

  private async assembleAndHash(uploadId: string, outputPath: string): Promise<string> {
    const chunkDir = this.chunkDirFor(uploadId);
    const files = (await fs.readdir(chunkDir)).filter((f) => f.startsWith("chunk-")).sort();
    const out = createWriteStream(outputPath);
    const hash = createHash("sha256");
    try {
      for (const file of files) {
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(join(chunkDir, file));
          stream.on("data", (buf) => {
            hash.update(buf);
            if (!out.write(buf)) stream.pause();
          });
          out.on("drain", () => stream.resume());
          stream.on("end", () => resolve());
          stream.on("error", reject);
        });
      }
    } finally {
      out.end();
    }
    await new Promise<void>((resolve) => out.on("close", () => resolve()));
    return hash.digest("hex");
  }
}

export default TrainingUploadService;
