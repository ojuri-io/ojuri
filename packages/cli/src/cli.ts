import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { down } from "./commands/down";
import { doctor } from "./commands/doctor";
import { init } from "./commands/init";
import { resetAdmin } from "./commands/reset-admin";
import { formatStatus, status } from "./commands/status";
import { up } from "./commands/up";
import { systemExec, systemProbe, type Exec, type Probe } from "./exec";
import { countBySeverity, formatHuman, formatJson, warning } from "./findings";
import { loadManifest } from "./manifest/load";
import { TEMPLATE_MANIFEST } from "./manifest/template";
import { DEFAULT_MANIFEST_FILENAME } from "./manifest/load";
import { DEFAULT_OUT_DIR, render } from "./render";
import { PACKAGE_DIR } from "./stack/package-dir";
import { validateManifest } from "./validate";

/** Read rather than duplicated: the hand-kept copy silently drifted from the package for two releases. */
export const VERSION: string = (
  JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }
).version;

const USAGE = `ojuri ${VERSION}

Usage:
  ojuri init                Write ojuri.yaml and a .env with fresh secrets.
  ojuri up [path]           Validate, render, and start the stack.
  ojuri down [path]         Stop the stack.
  ojuri status [path]       Container state and each service's readiness.
  ojuri doctor [path]       Check this host can run the stack.
  ojuri validate [path]     Check a manifest for problems.
  ojuri render [path]       Write the .env fragment and Compose overlay.
  ojuri reset-admin [path]  Issue a new admin password.

Options:
  --json                    Emit machine-readable output.
  --out-dir <dir>           Where render writes (default ${DEFAULT_OUT_DIR}).
  --build                   Build from source rather than pulling the
                            published images.
  --print-command           Print the Compose command and write nothing.
  --volumes                 With down, also delete the stack's data.
  --yes                     Skip the confirmation prompts.
  --keep-dev-defaults       With init, keep .env.example's development
                            secrets instead of generating new ones.
  --password <value>        With reset-admin, set this rather than
                            generating one.
  --username <name>         With reset-admin, the user to reset
                            (default admin).
  --tenant <id>             With reset-admin, its tenant (default
                            default).
  -h, --help                Show this message.
  -v, --version             Show the version.

With no path, every command reads ./${DEFAULT_MANIFEST_FILENAME}. They
exit 0 on success and 1 on failure. Warnings are printed but do not
change the exit code.

\`ojuri doctor\` checks this host and needs nothing set up first.
Then \`ojuri up\`, which writes a manifest and a .env if you have none.
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
export interface RunDeps {
  exec: Exec;
  probe: Probe;
}

const systemDeps: RunDeps = { exec: systemExec, probe: systemProbe };

export function run(
  argv: string[],
  streams: Streams = consoleStreams,
  processEnv: Record<string, string | undefined> = process.env
): number | Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        "out-dir": { type: "string" },
        build: { type: "boolean", default: false },
        "print-command": { type: "boolean", default: false },
        volumes: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        "keep-dev-defaults": { type: "boolean", default: false },
        password: { type: "string" },
        username: { type: "string" },
        tenant: { type: "string" },
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
    case "reset-admin":
      return resetAdminCommand(positionals[1] ?? DEFAULT_MANIFEST_FILENAME, {
        password: values.password,
        username: values.username,
        tenant: values.tenant,
        outDir: values["out-dir"],
        streams,
        processEnv,
      });
    case "init":
      return initCommand({
        dir: positionals[1],
        keepDevDefaults: values["keep-dev-defaults"] === true,
        streams,
      });
    case "up":
      return upCommand(positionals[1] ?? DEFAULT_MANIFEST_FILENAME, {
        build: values.build === true,
        yes: values.yes === true,
        outDir: values["out-dir"],
        streams,
        processEnv,
      });
    case "down":
      return downCommand(positionals[1] ?? DEFAULT_MANIFEST_FILENAME, {
        volumes: values.volumes === true,
        yes: values.yes === true,
        outDir: values["out-dir"],
        streams,
        processEnv,
      });
    case "status":
      return statusCommand(positionals[1] ?? DEFAULT_MANIFEST_FILENAME, {
        json: values.json === true,
        outDir: values["out-dir"],
        streams,
        processEnv,
      });
    case "doctor":
      return doctorCommand(positionals[1] ?? DEFAULT_MANIFEST_FILENAME, {
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

/** Overridden by the specs so the commands can run without Docker. */
export let deps: RunDeps = systemDeps;

export function _setDepsForTests(next: RunDeps): void {
  deps = next;
}

function resetAdminCommand(
  manifestPath: string,
  opts: {
    password?: string;
    username?: string;
    tenant?: string;
    outDir?: string;
    streams: Streams;
    processEnv: Record<string, string | undefined>;
  }
): number {
  const result = resetAdmin(
    manifestPath,
    {
      password: opts.password,
      username: opts.username,
      tenant: opts.tenant,
      outDir: opts.outDir,
      processEnv: opts.processEnv,
    },
    systemDeps
  );

  if (result.render.findings.length > 0) {
    opts.streams.out(formatHuman(result.render.manifestPath, result.render.findings));
  }
  for (const line of result.lines) opts.streams.out(line);
  for (const line of result.errors) opts.streams.err(line);
  return result.ok ? 0 : 1;
}

function initCommand(opts: {
  dir: string | undefined;
  keepDevDefaults: boolean;
  streams: Streams;
}): number {
  const result = init({ dir: opts.dir, keepDevDefaults: opts.keepDevDefaults });
  for (const message of result.messages) opts.streams.out(message);
  for (const message of result.errors) opts.streams.err(message);

  if (result.adminPassword) {
    opts.streams.out("");
    opts.streams.out("Generated a fresh AUTH_JWT_SECRET, POSTGRES_PASSWORD and");
    opts.streams.out("ADMIN_SEED_PASSWORD in .env. The admin password is:");
    opts.streams.out("");
    opts.streams.out(`  ${result.adminPassword}`);
    opts.streams.out("");
    opts.streams.out("It only takes effect on a fresh database, and .env is gitignored.");
  }

  if (result.ok) {
    opts.streams.out("");
    opts.streams.out("Next: `ojuri doctor` to check this host, then `ojuri up`.");
  }
  return result.ok ? 0 : 1;
}

async function upCommand(
  path: string,
  opts: {
    build: boolean;
    yes: boolean;
    outDir: string | undefined;
    streams: Streams;
    processEnv: Record<string, string | undefined>;
  }
): Promise<number> {
  const result = await up(
    path,
    { build: opts.build, yes: opts.yes, outDir: opts.outDir, processEnv: opts.processEnv },
    deps
  );

  if (!result.render.ok) {
    opts.streams.out(formatHuman(result.render.manifestPath, result.render.findings));
  } else if (result.render.findings.length > 0) {
    opts.streams.out(formatHuman(result.render.manifestPath, result.render.findings));
  }

  for (const line of result.errors) opts.streams.err(line);
  for (const line of result.lines) opts.streams.out(line);
  return result.ok ? 0 : 1;
}

function downCommand(
  path: string,
  opts: {
    volumes: boolean;
    yes: boolean;
    outDir: string | undefined;
    streams: Streams;
    processEnv: Record<string, string | undefined>;
  }
): number {
  const result = down(
    path,
    { volumes: opts.volumes, yes: opts.yes, outDir: opts.outDir, processEnv: opts.processEnv },
    deps
  );
  if (result.output) opts.streams.out(result.output);
  for (const line of result.errors) opts.streams.err(line);
  return result.ok ? 0 : 1;
}

async function statusCommand(
  path: string,
  opts: {
    json: boolean;
    outDir: string | undefined;
    streams: Streams;
    processEnv: Record<string, string | undefined>;
  }
): Promise<number> {
  const result = await status(
    path,
    { outDir: opts.outDir, processEnv: opts.processEnv },
    deps
  );

  if (opts.json) {
    opts.streams.out(
      JSON.stringify(
        { ok: result.ok, containers: result.containers, health: result.health },
        null,
        2
      )
    );
  } else {
    opts.streams.out(formatStatus(result));
    for (const line of result.errors) opts.streams.err(line);
  }
  return result.ok ? 0 : 1;
}

async function doctorCommand(
  path: string,
  opts: { json: boolean; streams: Streams; processEnv: Record<string, string | undefined> }
): Promise<number> {
  const requested = loadManifest(resolve(path), opts.processEnv);

  // Checking the host is worth doing before a manifest exists: `doctor` is the
  // first thing the help text suggests, and refusing to run until `init` has
  // been called sends an operator away from the command that would have told
  // them their Docker is too old. Nothing is written; the shipped default
  // stands in for a manifest they have not made yet.
  const absent = requested.findings.some((f) => f.code === "missing-manifest");
  const loaded = absent ? loadManifest(TEMPLATE_MANIFEST, opts.processEnv) : requested;

  if (loaded.manifest === null) {
    opts.streams.out(formatHuman(loaded.path, loaded.findings));
    return 1;
  }

  const { effective } = await import("./manifest/types");
  const findings = [
    ...(absent
      ? [
          warning(
            "no-manifest",
            "",
            "No ojuri.yaml here, so this checked the host against the default stack.",
            "`ojuri init` writes one. A manifest that enables FIA or an external " +
              "datastore would be checked differently."
          ),
        ]
      : []),
    ...(await doctor(effective(loaded.manifest), { exec: deps.exec })),
  ];

  // Report where the operator ran, not the template inside the package: a
  // node_modules path in a CI report reads as a misconfiguration.
  const reported = absent ? dirname(resolve(path)) : loaded.path;

  if (opts.json) {
    opts.streams.out(formatJson(reported, findings));
  } else {
    opts.streams.out(formatHuman(absent ? reported : dirname(loaded.path), findings));
  }
  return countBySeverity(findings).errors === 0 ? 0 : 1;
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
    opts.streams.out("The overlay is empty: this manifest changes nothing in the compose file.");
  }
  opts.streams.out("");
  opts.streams.out(result.command);
  return 0;
}
