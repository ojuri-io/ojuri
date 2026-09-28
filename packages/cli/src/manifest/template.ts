import { join } from "node:path";

/**
 * The default manifest shipped with the package, resolved relative to this
 * file so it holds from `dist/manifest/` after a build and from
 * `src/manifest/` under ts-jest.
 */
export const TEMPLATE_MANIFEST = join(__dirname, "..", "..", "templates", "ojuri.yaml");
