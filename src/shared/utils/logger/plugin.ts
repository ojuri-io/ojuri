import fp from 'fastify-plugin';
import Logger from '.';
import { getLogLevelFromStatusCode } from './util';

function logRequest(req, reply) {
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
