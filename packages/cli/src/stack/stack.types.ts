export interface StackSource {
  /** Directory holding docker-compose.yml and the assets it bind-mounts. */
  root: string;
  /** True when the assets travel inside the published package. */
  bundled: boolean;
}

export interface MaterialiseResult {
  stackDir: string;
  copied: string[];
  kept: string[];
}
