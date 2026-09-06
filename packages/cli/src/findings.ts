/**
 * A single validation result. `code` is stable and machine-readable so
 * CI can assert on it; `message` is the one-line summary and `detail`
 * carries the explanation an operator needs to act.
 */
export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  code: string;
  /** Dotted path into the manifest, or "" for findings about the file as a whole. */
  path: string;
  message: string;
  detail?: string;
}

export function error(code: string, path: string, message: string, detail?: string): Finding {
  return { severity: "error", code, path, message, detail };
}

export function warning(code: string, path: string, message: string, detail?: string): Finding {
  return { severity: "warning", code, path, message, detail };
}

export function countBySeverity(findings: Finding[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Human-readable report. Errors first, then warnings, each in the order
 * the rules produced them.
 */
export function formatHuman(manifestPath: string, findings: Finding[]): string {
  const { errors, warnings } = countBySeverity(findings);
  const lines: string[] = [manifestPath, ""];

  if (findings.length === 0) {
    lines.push("  No problems found.", "");
    return lines.join("\n");
  }

  const ordered = [
    ...findings.filter((f) => f.severity === "error"),
    ...findings.filter((f) => f.severity === "warning"),
  ];

  for (const f of ordered) {
    const label = f.severity === "error" ? "error  " : "warning";
    const where = f.path === "" ? "" : `  ${f.path}`;
    // A finding about the file as a whole has no path, and a header of
    // "error" followed by trailing spaces reads as a rendering bug.
    lines.push(`  ${label}${where}`.trimEnd());
    lines.push(`    ${f.message}`);
    if (f.detail) {
      for (const line of wrap(f.detail, 72)) lines.push(`    ${line}`);
    }
    lines.push("");
  }

  lines.push(`${plural(errors, "error")}, ${plural(warnings, "warning")}.`, "");
  return lines.join("\n");
}

export interface JsonReport {
  ok: boolean;
  manifest: string;
  errors: number;
  warnings: number;
  findings: Finding[];
}

export function formatJson(manifestPath: string, findings: Finding[]): string {
  const { errors, warnings } = countBySeverity(findings);
  const report: JsonReport = {
    ok: errors === 0,
    manifest: manifestPath,
    errors,
    warnings,
    findings,
  };
  return JSON.stringify(report, null, 2);
}

/** Greedy word wrap. Keeps detail text readable in a terminal. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}
