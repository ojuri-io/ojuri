import auditTrailRoute from "../../v1/modules/audit-trails/routes/audit-trail.route";
import appRoute from "../../v1/modules/app/app.route";
import healthRoute from "../../v1/modules/health/health.route";
import healthV1Route from "../../v1/modules/health/health-v1.route";
import rdaRoute from "../../v1/modules/rda/routes/predict.route";
import adminRoute from "../../v1/modules/admin/routes/admin.route";
import authRoute from "../../v1/modules/auth/routes/auth.route";
import statsRoute from "../../v1/modules/stats/routes/stats.route";
import notificationsRoute from "../../v1/modules/notifications/routes/notifications.route";
import trainingRoute from "../../v1/modules/training/routes/training.route";
import labelsRoute from "../../v1/modules/labels/routes/labels.route";

export default {
  app: appRoute,
  health: healthRoute,
  healthV1: healthV1Route,
  auditTrail: auditTrailRoute,
  rda: rdaRoute,
  admin: adminRoute,
  auth: authRoute,
  stats: statsRoute,
  notifications: notificationsRoute,
  training: trainingRoute,
  labels: labelsRoute,
};
