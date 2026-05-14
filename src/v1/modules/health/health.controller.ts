import { FastifyReply, FastifyRequest } from 'fastify';
import { injectable } from 'tsyringe';
import HealthService from './health.service';
import { SuccessResponse } from '@shared/utils/response.util';

@injectable()
class HealthController {
  constructor(private healthService: HealthService) {}

  readinessCheck = async (req: FastifyRequest, res: FastifyReply) => {
    await this.healthService.readinessCheck(req, res);
  };

  livelinessCheck = async (req: FastifyRequest, res: FastifyReply) => {
    await this.healthService.livelinessCheck(req, res);
  };

  services = async (_req: FastifyRequest, res: FastifyReply) => {
    const rows = await this.healthService.serviceProbes();
    return res.send(SuccessResponse('Service health', rows));
  };

  infra = async (_req: FastifyRequest, res: FastifyReply) => {
    const rows = await this.healthService.infraProbes();
    return res.send(SuccessResponse('Infra health', rows));
  };
}

export default HealthController;
