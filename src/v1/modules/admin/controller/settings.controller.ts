import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { injectable } from "tsyringe";
import RuntimeSettingsService from "@shared/settings/runtime-settings.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";

/**
 * Runtime settings admin endpoints.
 *
 * Settings are key/value rows in `runtimeSettings`. The service layer
 * owns validation (type coercion + numeric clamps) — controller just
 * routes requests and maps errors to HTTP codes.
 *
 * Why GET requires its own permission (`settings:read`) rather than
 * piggy-backing on `models:read`: FRAUD_ANALYST should be able to see
 * the active threshold from the Settings page without seeing model
 * lifecycle controls.
 */
@injectable()
class SettingsController {
  constructor(private readonly runtimeSettings: RuntimeSettingsService) {}

  list = async (_req: FastifyRequest, res: FastifyReply) => {
    const rows = await this.runtimeSettings.listAll();
    return res.send(SuccessResponse("Runtime settings", rows));
  };

  update = async (
    req: FastifyRequest<{ Params: { key: string }; Body: { value: unknown } }>,
    res: FastifyReply
  ) => {
    const updatedBy = req.auth?.username ?? null;
    const result = await this.runtimeSettings.update(
      req.params.key,
      (req.body as { value: unknown })?.value,
      updatedBy
    );
    if (!result.ok) {
      return res.code(httpStatus.UNPROCESSABLE_ENTITY).send(ErrorResponse(result.reason));
    }
    return res.send(SuccessResponse("Runtime setting updated", result.value as Record<string, unknown>));
  };
}

export default SettingsController;
