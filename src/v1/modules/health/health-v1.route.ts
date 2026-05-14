import { FastifyPluginAsync } from 'fastify';
import { container } from 'tsyringe';
import HealthController from './health.controller';
import { requireAuth } from '@shared/middlewares/require-auth.middleware';

const healthController = container.resolve(HealthController);

/**
 * Dashboard-facing health endpoints. The `/livez` + `/readyz` pair in
 * `health.route.ts` is kept at root for orchestrators (k8s, ALB);
 * these are mounted under `/v1` because they're authenticated and
 * power the Service Health page.
 */
const healthV1Route: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: 'GET',
    url: '/health/services',
    preHandler: [requireAuth('metrics:read')],
    handler: healthController.services,
  });

  fastify.route({
    method: 'GET',
    url: '/health/infra',
    preHandler: [requireAuth('metrics:read')],
    handler: healthController.infra,
  });
};

export default healthV1Route;
