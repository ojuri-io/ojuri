export interface ApiKeyContext {
  id: string;
  tenantId: string;
  name: string;
  scope: string;
  rateLimitPerMinute: number;
}

// Fastify augmentation for req.apiKey / req.auth lives in
// src/types/fastify.d.ts — kept in one place so the declarations don't
// fight each other across modules.
