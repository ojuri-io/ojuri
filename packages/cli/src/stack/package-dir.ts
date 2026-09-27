import { join } from "node:path";

/**
 * Resolved from this file so it holds from `dist/stack/` after a build and
 * from `src/stack/` under ts-jest, matching how the manifest template is
 * located in `commands/init.ts`.
 */
export const PACKAGE_DIR = join(__dirname, "..", "..");
