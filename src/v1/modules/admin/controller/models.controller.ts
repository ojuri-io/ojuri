import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import ModelRegistryService from "@shared/models/model-registry.service";
import DecisionAuditRepo from "@shared/audit/repositories/decision-audit.repo";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import {
  RegisterModelDto,
  SetModelStatusDto,
  SetSegmentThresholdDto,
  UpdateModelDto,
} from "../dtos/model.dto";

@injectable()
class ModelsController {
  constructor(
    private modelRegistry: ModelRegistryService,
    private auditRepo: DecisionAuditRepo
  ) {}

  /**
   * Champion-vs-shadow replay summary. Numbers are computed off the
   * `decisionAuditLog` rows where both `championModelVersion` and
   * `shadowModelVersion` match the requested labels. When decisions in
   * the window carry ground truth (chargebacks / disputes / reviewer
   * overrides via the labels flow), per-model precision/recall/F1 and
   * McNemar's p are computed live; otherwise they are null and the UI
   * renders "—".
   */
  comparison = async (
    req: FastifyRequest<{
      Querystring: {
        championVersion?: string;
        shadowVersion?: string;
        from?: string;
        to?: string;
      };
    }>,
    res: FastifyReply
  ) => {
    const championVersion =
      req.query.championVersion || this.modelRegistry.getChampion()?.version;
    const shadowVersion =
      req.query.shadowVersion || this.modelRegistry.getShadow()?.version;
    if (!championVersion || !shadowVersion) {
      return res.send(
        SuccessResponse("Model comparison", {
          championVersion: championVersion ?? null,
          shadowVersion: shadowVersion ?? null,
          replayed: 0,
          agreement: null,
          netDeclineDelta: null,
          mcnemarP: null,
          scoreBuckets: { champion: new Array(20).fill(0), shadow: new Array(20).fill(0) },
        })
      );
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(to.getTime() - 24 * 3600 * 1000);

    const cmp = await this.auditRepo.modelComparison(
      championVersion,
      shadowVersion,
      from,
      to
    );

    return res.send(
      SuccessResponse("Model comparison", {
        championVersion,
        shadowVersion,
        from: from.toISOString(),
        to: to.toISOString(),
        replayed: cmp.replayed,
        agreement: cmp.replayed > 0 ? cmp.agreement : null,
        netDeclineDelta: cmp.replayed > 0 ? cmp.netDeclineDelta : null,
        labeled: cmp.labeled,
        mcnemarP: cmp.mcnemarP,
        metrics: {
          champion: cmp.championMetrics,
          shadow: cmp.shadowMetrics,
        },
        scoreBuckets: {
          champion: cmp.championBuckets,
          shadow: cmp.shadowBuckets,
        },
      })
    );
  };

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

  listSegmentThresholds = async (_req: FastifyRequest, res: FastifyReply) => {
    return res.send(
      SuccessResponse("Segment thresholds", await this.modelRegistry.listSegmentThresholds())
    );
  };

  /**
   * Hard-delete a retired model version + its on-disk artefacts.
   * Refuses ACTIVE / SHADOW with 409 — operators must retire first.
   * Requires the `models:delete` permission.
   */
  delete = async (req: FastifyRequest<{ Params: { version: string } }>, res: FastifyReply) => {
    try {
      const removed = await this.modelRegistry.deleteVersion(req.params.version);
      if (!removed) {
        return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Model not found"));
      }
      return res.send(SuccessResponse("Model version deleted"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Status-conflict (still ACTIVE/SHADOW) is the only expected
      // error shape from the service — surface 409 so the UI can
      // prompt "retire first".
      if (msg.startsWith("Cannot delete")) {
        return res.code(httpStatus.CONFLICT).send(ErrorResponse(msg));
      }
      return res.code(httpStatus.INTERNAL_SERVER_ERROR).send(ErrorResponse(msg));
    }
  };
}

export default ModelsController;
