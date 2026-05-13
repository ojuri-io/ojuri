import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import ModelRegistryService from "@shared/models/model-registry.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import {
  RegisterModelDto,
  SetModelStatusDto,
  SetSegmentThresholdDto,
  UpdateModelDto,
} from "../dtos/model.dto";

@injectable()
class ModelsController {
  constructor(private modelRegistry: ModelRegistryService) {}

  register = async (req: FastifyRequest<{ Body: RegisterModelDto }>, res: FastifyReply) => {
    const row = await this.modelRegistry.register(req.body);
    return res.code(httpStatus.CREATED).send(SuccessResponse("Model registered", row));
  };

  list = async (_req: FastifyRequest, res: FastifyReply) => {
    return res.send(SuccessResponse("Models", await this.modelRegistry.list()));
  };

  update = async (
    req: FastifyRequest<{ Params: { version: string }; Body: UpdateModelDto }>,
    res: FastifyReply
  ) => {
    const row = await this.modelRegistry.update(req.params.version, req.body);
    if (!row) return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Model not found"));
    return res.send(SuccessResponse("Model updated", row));
  };

  setStatus = async (
    req: FastifyRequest<{ Params: { version: string }; Body: SetModelStatusDto }>,
    res: FastifyReply
  ) => {
    const row = await this.modelRegistry.setStatus(req.params.version, req.body.status);
    if (!row) return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Model not found"));
    return res.send(SuccessResponse("Model status updated", row));
  };

  setSegmentThreshold = async (
    req: FastifyRequest<{ Body: SetSegmentThresholdDto }>,
    res: FastifyReply
  ) => {
    await this.modelRegistry.setSegmentThreshold(req.body);
    return res.code(httpStatus.CREATED).send(SuccessResponse("Segment threshold saved"));
  };
}

export default ModelsController;
