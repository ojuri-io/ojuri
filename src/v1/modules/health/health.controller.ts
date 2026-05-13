import { FastifyReply, FastifyRequest } from 'fastify';
import { injectable } from 'tsyringe';
import HealthService from './health.service';

@injectable()
class HealthController {
  constructor(private healthService: HealthService) {}

  readinessCheck = async (req: FastifyRequest, res: FastifyReply) => {
    await this.healthService.readinessCheck(req, res);
  };

  livelinessCheck = async (req: FastifyRequest, res: FastifyReply) => {
    await this.healthService.livelinessCheck(req, res);
  };
}

export default HealthController;
