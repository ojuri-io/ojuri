import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import { SuccessResponse } from "@shared/utils/response.util";
import LabelService from "../services/label.service";
import { IngestLabelsRequestDto } from "../dtos/label.dto";

@injectable()
class LabelController {
  constructor(private readonly service: LabelService) {}

  ingest = async (
    req: FastifyRequest<{ Body: IngestLabelsRequestDto }>,
    res: FastifyReply,
  ): Promise<void> => {
    const recordedBy = req.auth?.username ?? req.apiKey?.id ?? "unknown";
    const result = await this.service.ingest(req.body, recordedBy);
    res.code(httpStatus.OK).send(SuccessResponse("Labels ingested", result));
  };
}

export default LabelController;
