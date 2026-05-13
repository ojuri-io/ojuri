import { FastifyReply, FastifyRequest } from 'fastify';
import httpStatus from 'http-status';
import jwt from 'jsonwebtoken';
import { ErrorResponse } from '@shared/utils/response.util';

const authMiddleware = (req: FastifyRequest, res: FastifyReply, done) => {
  try {
    const authToken = getAuthTokenFromRequestHeader(req);
    if (!authToken) {
      throw new Error();
    }

    const payload = jwt.decode(authToken);

    (req as any).user = payload.user;

    done();
  } catch (err) {
    return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse('You are unauthorized'));
  }
};

const getAuthTokenFromRequestHeader = (req: FastifyRequest): string | null => {
  const authTokenSegments = (req.headers.authorization || '').split(' ');

  return authTokenSegments.length === 2 ? authTokenSegments[1] : null;
};

export default authMiddleware;
