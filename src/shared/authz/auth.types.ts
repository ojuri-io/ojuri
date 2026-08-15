export interface LiveGrants {
  permissions: string[];
  mustChangePassword: boolean;
}

export interface GrantsCacheEntry {
  grants: LiveGrants | null;
  expiresAt: number;
}

export interface DemoAccount {
  username: string;
  credentialsUrl: string | null;
}

export interface SignInOptions {
  demoAccount: DemoAccount | null;
}

export interface SignInOptionsCacheEntry {
  options: SignInOptions;
  expiresAt: number;
}
