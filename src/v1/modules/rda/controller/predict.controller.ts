import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import { randomUUID } from "crypto";
import PredictService from "../services/predict.service";
import { PredictRequestDto } from "../dtos/predict-request.dto";
import { ErrorResponse } from "@shared/utils/response.util";
import { metricsService } from "@shared/metrics/metrics.service";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";

const log = createServiceLogger("PredictController");

/**
 * Controller for fraud prediction endpoints
 */
@injectable()
class PredictController {
  constructor(private predictService: PredictService) {}

  /**
   * Handle POST /predict request
   * Main fraud detection endpoint
   */
  predict = async (
    req: FastifyRequest<{ Body: PredictRequestDto }>,
    res: FastifyReply
  ): Promise<void> => {
    const startTime = Date.now();
    const traceId = `req-${(req.headers["x-correlation-id"] as string) || randomUUID()}`;
    const request = req.body;

    return TraceContext.runAsync(
      { traceId, transactionId: request.transaction_id, senderId: request.sender_id },
      async () => {
        log.entry("predict", "Processing fraud prediction request", {
          transactionId: request.transaction_id,
          senderId: request.sender_id,
          receiverId: request.receiver_id,
          amount: request.amount,
          transactionType: request.transaction_type,
        });

        try {
          const response = await this.predictService.predict(request, traceId);

          const latencyMs = Date.now() - startTime;
          metricsService.recordRequest("POST", "/predict", httpStatus.OK);
          metricsService.recordLatency("POST", "/predict", latencyMs);

          log.success("predict", "Fraud prediction completed", {
            transactionId: response.transaction_id,
            fraud: response.fraud,
            fraudProbability: response.fraud_probability,
            decision: response.decision,
            latencyMs,
          });

          res
            .code(httpStatus.OK)
            .header("X-Correlation-ID", traceId)
            .header("X-Response-Time", `${latencyMs}ms`)
            .send(response);
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;

          log.error("predict", "Failed to process prediction request", {
            transactionId: request.transaction_id,
            latencyMs,
            error: err instanceof Error ? err.message : String(err),
          });

          metricsService.recordRequest("POST", "/predict", httpStatus.INTERNAL_SERVER_ERROR);
          metricsService.recordError("request_error");

          res
            .code(httpStatus.INTERNAL_SERVER_ERROR)
            .header("X-Correlation-ID", traceId)
            .send(ErrorResponse("Failed to process prediction request"));
        }
      }
    );
  };

  /**
   * Get Prometheus metrics
   */
  getMetrics = async (_req: FastifyRequest, res: FastifyReply): Promise<void> => {
    try {
      const metrics = await metricsService.getMetrics();
      res.code(httpStatus.OK).header("Content-Type", metricsService.getContentType()).send(metrics);
    } catch (err) {
      log.error("getMetrics", "Failed to get metrics", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.code(httpStatus.INTERNAL_SERVER_ERROR).send(ErrorResponse("Failed to get metrics"));
    }
  };
}

export default PredictController;
