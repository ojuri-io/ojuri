/**
 * Every path docker-compose.yml bind-mounts from the host, so a published
 * package can carry them and `ojuri up` can run outside a checkout.
 * `test/stack-assets.spec.ts` pins this list against the real compose file.
 */
export const BUNDLED_FILES = [
  "docker-compose.yml",
  "docker-compose.ghcr.yml",
  ".env.example",
  "nginx/nginx.conf",
  "nginx/nginx.sentinel.conf",
  "prometheus/prometheus.yml",
  "models/fraud_model.onnx",
  "models/feature-catalog.v1.json",
  "models/feature-catalog.adopter.example.json",
  "models/lookups/country_risk.json",
  "scripts/demo-traffic.mjs",
] as const;

/** Mount targets Compose expects to exist and write into. */
export const RUNTIME_DIRECTORIES = [
  "data/training-imports",
  "data/training-uploads",
  "fia-service/models",
] as const;
