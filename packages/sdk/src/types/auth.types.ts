export interface LoginInput {
  username: string;
  password: string;
  tenantId?: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    username: string;
    fullName: string | null;
    tenantId: string;
    roles: { id: string; name: string }[];
    permissions: string[];
    mustChangePassword: boolean;
  };
}
