import { parseArgs } from "node:util";
import { formatHuman, formatJson } from "./findings";
import { DEFAULT_MANIFEST_FILENAME } from "./manifest/load";
import { validateManifest } from "./validate";

export const VERSION = "1.6.0";

const USAGE = `ojuri ${VERSION}

Usage:
  ojuri validate [path]     Check a manifest for problems.

Options:
  --json                    Emit machine-readable output.
  -h, --help                Show this message.
  -v, --version             Show the version.

With no path, validate reads ./${DEFAULT_MANIFEST_FILENAME}. It exits 0
when the manifest is usable and 1 when it is not. Warnings are printed
but do not change the exit code.
`;

export interface Streams {
  out: (text: string) => void;
  err: (text: string) => void;
}

const consoleStreams: Streams = {
  /* eslint-disable no-console */
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  /* eslint-enable no-console */
};

/**
 * Returns the process exit code rather than calling process.exit, so
 * the specs can drive it directly.
 */
export function run(
  argv: string[],
  streams: Streams = consoleStreams,
  processEnv: Record<string, string | undefined> = process.env
): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    streams.err(err instanceof Error ? err.message : String(err));
    streams.err(USAGE);
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    streams.out(VERSION);
    return 0;
  }

  const command = positionals[0];

  if (values.help || command === undefined) {
    streams.out(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  switch (command) {
    case "validate":
      return validateCommand(positionals[1] ?? DEFAULT_MANIFEST_FILENAME, {
        json: values.json === true,
        streams,
        processEnv,
      });
    default:
      streams.err(`Unknown command "${command}".`);
      streams.err(USAGE);
      return 1;
  }
}

function validateCommand(
  path: string,
  opts: { json: boolean; streams: Streams; processEnv: Record<string, string | undefined> }
): number {
  const result = validateManifest(path, opts.processEnv);

  if (opts.json) {
    opts.streams.out(formatJson(result.path, result.findings));
  } else {
    opts.streams.out(formatHuman(result.path, result.findings));
  }

  return result.ok ? 0 : 1;
}
