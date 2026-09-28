import { ObjectLiteral } from '../types/object-literal.type';

export const SuccessResponse = (message: string, data?: ObjectLiteral, meta?: ObjectLiteral) => {
  return {
    status: true,
    message,
    data,
    meta,
  };
};

/**
 * `code` is what a client should branch on. Two conditions return 409 and mean
 * opposite things — an Idempotency-Key still in flight, which the caller should
 * retry, and a transaction_id already processed, which it should not — and
 * without a code the only way to tell them apart is matching the message text.
 */
export const ErrorResponse = (message: string, errors?: any[], code?: string) => {
  return {
    status: false,
    message,
    code,
    errors,
  };
};
