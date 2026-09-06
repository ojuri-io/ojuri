import { parseArgs } from "node:util";
import { formatHuman, formatJson } from "./findings";
import { DEFAULT_MANIFEST_FILENAME } from "./manifest/load";
import { DEFAULT_OUT_DIR, render } from "./render";
import { validateManifest } from "./validate";

export const VERSION = "1.6.0";

const USAGE = `ojuri ${VERSION}

Usage:
  ojuri validate [path]     Check a manifest for problems.
  ojuri render [path]       Write the .env fragment and Compose overlay.

Options:
  --json                    Emit machine-readable output.
  --out-dir <dir>           Where render writes (default ${DEFAULT_OUT_DIR}).
  --build                   Render the command for building from source
                            rather than pulling published images.
  --print-command           Print the Compose command and write nothing.
  -h, --help                Show this message.
  -v, --version             Show the version.

With no path, both read ./${DEFAULT_MANIFEST_FILENAME}. They exit 0 when
the manifest is usable and 1 when it is not. Warnings are printed but do
not change the exit code.
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
        "out-dir": { type: "string" },
        build: { type: "boolean", default: false },
        "print-command": { type: "boolean", default: false },
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
    case "render":
      return renderCommand(positionals[1] ?? DEFAULT_MANIFEST_FILENAME, {
        json: values.json === true,
        outDir: values["out-dir"],
        build: values.build === true,
        printCommand: values["print-command"] === true,
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

interface RenderCommandOptions {
  json: boolean;
  outDir: string | undefined;
  build: boolean;
  printCommand: boolean;
  streams: Streams;
  processEnv: Record<string, string | undefined>;
}

function renderCommand(path: string, opts: RenderCommandOptions): number {
  const result = render(path, {
    outDir: opts.outDir,
    build: opts.build,
    // --print-command is a query, not a change: it must not leave files
    // behind on a host the operator was only inspecting.
    dryRun: opts.printCommand,
    processEnv: opts.processEnv,
  });

  if (opts.json) {
    opts.streams.out(
      JSON.stringify(
        {
          ok: result.ok,
          manifest: result.manifestPath,
          command: result.command,
          noOp: result.noOp,
          written: result.written,
          profiles: result.plan?.profiles ?? [],
          dropped: result.plan?.dropped ?? [],
          env: result.plan?.env ?? {},
          findings: result.findings,
        },
        null,
        2
      )
    );
    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    opts.streams.out(formatHuman(result.manifestPath, result.findings));
    opts.streams.err("Nothing was rendered: fix the errors above first.");
    return 1;
  }

  if (opts.printCommand) {
    opts.streams.out(result.command);
    return 0;
  }

  const warnings = result.findings.length;
  if (warnings > 0) opts.streams.out(formatHuman(result.manifestPath, result.findings));

  for (const file of result.written) opts.streams.out(`wrote ${file}`);
  if (result.noOp) {
    opts.streams.out("");
    opts.streams.out("The overlay is empty: this manifest describes the shipped stack exactly.");
  }
  opts.streams.out("");
  opts.streams.out(result.command);
  return 0;
}
