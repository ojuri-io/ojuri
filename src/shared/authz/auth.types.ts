export interface LiveGrants {
  permissions: string[];
  mustChangePassword: boolean;
}

export interface GrantsCacheEntry {
  grants: LiveGrants | null;
  expiresAt: number;
}
