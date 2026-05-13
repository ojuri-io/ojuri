import { FastifyPluginAsync } from 'fastify';
import { container } from 'tsyringe';
import AppController from './app.controller';

const appController = container.resolve(AppController);

const appRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {}, appController.getHello);
};

export default appRoute;
