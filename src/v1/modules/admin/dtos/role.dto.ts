export interface CreateRoleDto {
  name: string;
  description?: string;
  permissions: string[];
  tenantId?: string;
}

export interface UpdateRoleDto {
  name?: string;
  description?: string | null;
  permissions?: string[];
}
