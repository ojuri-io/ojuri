import { FastifyPluginAsync } from 'fastify';
import { container } from 'tsyringe';
import HealthController from './health.controller';

const healthController = container.resolve(HealthController);

const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/readyz', {}, healthController.readinessCheck);

  fastify.get('/livez', {}, healthController.livelinessCheck);
};

export default healthRoute;
