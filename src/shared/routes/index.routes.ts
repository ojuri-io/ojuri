import auditTrailRoute from "../../v1/modules/moduleName/routes/audit-trail.route";
import appRoute from "../../v1/modules/app/app.route";
import healthRoute from "../../v1/modules/health/health.route";
import rdaRoute from "../../v1/modules/rda/routes/predict.route";
import adminRoute from "../../v1/modules/admin/routes/admin.route";

export default {
  app: appRoute,
  health: healthRoute,
  auditTrail: auditTrailRoute,
  rda: rdaRoute,
  admin: adminRoute,
};
