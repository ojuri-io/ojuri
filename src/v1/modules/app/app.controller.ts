import { FastifyReply, FastifyRequest } from 'fastify';
import { injectable } from 'tsyringe';
import AppService from './app.service';

@injectable()
class AppController {
  constructor(private appService: AppService) {}

  getHello = async (req: FastifyRequest, res: FastifyReply) => {
    res.send(this.appService.getHello());
  };
}

export default AppController;
