export interface ApiKeyContext {
  id: string;
  tenantId: string;
  name: string;
  scope: string;
  rateLimitPerMinute: number;
}

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: ApiKeyContext;
  }
}
