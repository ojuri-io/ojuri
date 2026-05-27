import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Logger from '.';
import { getLogLevelFromStatusCode } from './util';

function logRequest(req: FastifyRequest, reply: FastifyReply) {
  const logLevel = getLogLevelFromStatusCode(reply.raw.statusCode);

  Logger[logLevel]({
    req: req,
    res: reply,
  });
}

export default fp((fastify, options, done) => {
  fastify.addHook('preSerialization', (req, reply, payload, done) => {
    Object.assign(reply.raw, { payload });

    done();
  });

  fastify.addHook('onResponse', logRequest);

  done();
});
