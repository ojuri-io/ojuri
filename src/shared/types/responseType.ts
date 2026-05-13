export type ResponseType<T = any> = {
  status: boolean;
  message: string;
  data?: T;
};
