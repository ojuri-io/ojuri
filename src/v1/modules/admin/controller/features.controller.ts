import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import { loadCatalog } from "@shared/features/feature-catalog";
import { SuccessResponse } from "@shared/utils/response.util";

/**
 * Read-only endpoint that exposes the running feature catalogue to the
 * Sentinel dashboard. The catalogue is loaded once at boot and cached;
 * a change requires a process restart, so what this controller returns
 * is exactly what RDA is using to build inference vectors right now.
 *
 * Why read-only: editing the catalogue from the UI is out of scope for
 * v1 — adopters change `models/feature-catalog.adopter.json` on disk
 * and restart. Editing live would require atomic re-fit of every
 * deployed model, which the platform doesn't support.
 */
@injectable()
class FeaturesController {
  catalog = async (_req: FastifyRequest, res: FastifyReply) => {
    const c = loadCatalog();
    return res.send(
      SuccessResponse("Feature catalogue retrieved", {
        schemaVersion: c.schemaVersion,
        baseVersion: c.baseVersion,
        inputDimension: c.inputDimension,
        adopterSha256: c.adopterSha256,
        features: c.features.map((f) => ({
          index: f.index,
          name: f.name,
          category: f.category,
          source: f.source,
          dtype: f.dtype,
          default: f.default,
          description: f.description,
          compute: f.compute ?? null,
        })),
      })
    );
  };
}

export default FeaturesController;
