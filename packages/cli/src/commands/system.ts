import { statfsSync } from "node:fs";
import { totalmem as osTotalmem } from "node:os";

/** Thin wrappers so the doctor's host checks can be stubbed in specs. */
export function totalmem(): number {
  return osTotalmem();
}

export function statfs(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
