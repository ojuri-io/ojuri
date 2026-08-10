locals {
  ssm_prefix = "/ojuri/${var.environment}"
}

# Alphanumeric rather than mixed symbols: these values are interpolated into a
# .env file, a shell environment, and a Postgres connection string, and every
# punctuation class breaks at least one of those. 48 alphanumeric characters
# carry far more entropy than the 32-character minimum the services check for.
resource "random_password" "jwt_secret" {
  length  = 48
  special = false
}

resource "random_password" "mla_service_token" {
  length  = 48
  special = false
}

resource "random_password" "postgres" {
  length  = 48
  special = false
}

resource "random_password" "grafana" {
  length  = 24
  special = false
}

# Without this the seed migration invents a password and prints it once to the
# migration container's logs. That is fine on a laptop and bad on a box anyone
# can wake from a public button: whoever reaches Sentinel first would claim the
# super-admin account. Generating it here means the credential exists in SSM
# before the instance ever answers a request.
resource "random_password" "admin_seed" {
  length  = 32
  special = false
}

# Secrets live only in SSM and in Terraform state — never in the repository,
# never in a tfvars file, and never in the instance's user-data (which any
# process on the box can read back from the metadata service).
resource "aws_ssm_parameter" "jwt_secret" {
  name        = "${local.ssm_prefix}/AUTH_JWT_SECRET"
  description = "RDA + FIA shared JWT signing secret"
  type        = "SecureString"
  value       = random_password.jwt_secret.result
}

resource "aws_ssm_parameter" "mla_service_token" {
  name        = "${local.ssm_prefix}/MLA_SERVICE_TOKEN"
  description = "MLA -> RDA model registration token"
  type        = "SecureString"
  value       = random_password.mla_service_token.result
}

resource "aws_ssm_parameter" "postgres_password" {
  name        = "${local.ssm_prefix}/POSTGRES_PASSWORD"
  description = "Postgres superuser password"
  type        = "SecureString"
  value       = random_password.postgres.result
}

resource "aws_ssm_parameter" "grafana_password" {
  name        = "${local.ssm_prefix}/GRAFANA_PASSWORD"
  description = "Grafana admin password"
  type        = "SecureString"
  value       = random_password.grafana.result
}

resource "aws_ssm_parameter" "admin_seed_password" {
  name        = "${local.ssm_prefix}/ADMIN_SEED_PASSWORD"
  description = "Sentinel admin bootstrap password; rotated on first login"
  type        = "SecureString"
  value       = random_password.admin_seed.result
}
