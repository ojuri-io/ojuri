export interface SuccessEnvelope<T> {
  status: true;
  message: string;
  data: T;
  meta?: unknown;
}

export interface ErrorEnvelope {
  status: false;
  message: string;
  errors?: unknown[];
}
