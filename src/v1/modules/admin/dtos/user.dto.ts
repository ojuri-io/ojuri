export interface CreateUserDto {
  username: string;
  password: string;
  fullName?: string;
  email?: string;
  tenantId?: string;
  roleIds?: string[];
}

export interface UpdateUserDto {
  password?: string;
  fullName?: string | null;
  email?: string | null;
  isActive?: boolean;
  disabledReason?: string | null;
}

export interface AssignRoleDto {
  roleId: string;
}
