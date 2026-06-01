import { ParsedTransactionRow, TrainingTransformSpec } from "./training.types";

const REQUIRED_COLUMNS = [
  "transactionId",
  "senderId",
  "receiverId",
  "amount",
  "transactionType",
  "timestamp",
] as const;

export interface CsvRowParseResult {
  row: ParsedTransactionRow | null;
  error: string | null;
}

// Applies headerMap to the CSV's column list. Source columns named on the
// left of the map (the file's actual headers) are renamed to the right
// (the canonical name the parser expects).
export function applyHeaderMap(columns: string[], spec?: TrainingTransformSpec | null): string[] {
  const map = spec?.headerMap ?? {};
  return columns.map((c) => map[c] ?? c);
}

export function parseCsvHeader(
  headerLine: string,
  spec?: TrainingTransformSpec | null,
): { columns: string[]; missing: string[] } {
  const raw = splitCsv(headerLine).map((c) => c.trim());
  const columns = applyHeaderMap(raw, spec);
  const filledByDefaults = new Set(Object.keys(spec?.columnDefaults ?? {}));
  const missing = REQUIRED_COLUMNS.filter((req) => !columns.includes(req) && !filledByDefaults.has(req));
  return { columns, missing };
}

export function parseCsvRow(
  columns: string[],
  line: string,
  spec?: TrainingTransformSpec | null,
): CsvRowParseResult {
  const values = splitCsv(line);
  if (values.length !== columns.length) {
    return { row: null, error: `column count mismatch: got ${values.length}, expected ${columns.length}` };
  }
  const map: Record<string, string> = {};
  for (let i = 0; i < columns.length; i++) {
    map[columns[i]!] = (values[i] ?? "").trim();
  }
  if (spec?.columnDefaults) {
    for (const [col, def] of Object.entries(spec.columnDefaults)) {
      if (!map[col]) map[col] = def;
    }
  }
  if (spec?.dropEmptyRows) {
    const nonEmpty = Object.values(map).some((v) => v && v.length > 0);
    if (!nonEmpty) return { row: null, error: "row is empty" };
  }
  for (const req of REQUIRED_COLUMNS) {
    if (!map[req]) return { row: null, error: `missing required column: ${req}` };
  }
  const amount = Number(map.amount);
  const timestamp = Number(map.timestamp);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { row: null, error: `invalid amount: ${map.amount}` };
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { row: null, error: `invalid timestamp: ${map.timestamp}` };
  }
  return {
    row: {
      transactionId: map.transactionId!,
      senderId: map.senderId!,
      receiverId: map.receiverId!,
      amount,
      transactionType: map.transactionType!,
      timestamp,
      fraudLabel: parseOptionalBool(map.fraudLabel),
      groundTruthFraud: parseOptionalBool(map.groundTruthFraud),
      channel: emptyToNull(map.channel),
      currency: emptyToNull(map.currency),
      accountAgeDays: parseOptionalInt(map.accountAgeDays),
      ipCountry: emptyToNull(map.ipCountry),
      transactionCountry: emptyToNull(map.transactionCountry),
      sessionToTxnSeconds: parseOptionalInt(map.sessionToTxnSeconds),
      deviceIsTrusted: parseOptionalBool(map.deviceIsTrusted),
      isAuthenticated: parseOptionalBool(map.isAuthenticated),
    },
    error: null,
  };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseOptionalBool(v?: string): boolean | null {
  if (v == null || v === "") return null;
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return null;
}

function parseOptionalInt(v?: string): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function emptyToNull(v?: string): string | null {
  return v == null || v === "" ? null : v;
}
