import { ParsedTransactionRow } from "./training.types";

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

export function parseCsvHeader(headerLine: string): { columns: string[]; missing: string[] } {
  const columns = splitCsv(headerLine).map((c) => c.trim());
  const missing = REQUIRED_COLUMNS.filter((req) => !columns.includes(req));
  return { columns, missing };
}

export function parseCsvRow(columns: string[], line: string): CsvRowParseResult {
  const values = splitCsv(line);
  if (values.length !== columns.length) {
    return { row: null, error: `column count mismatch: got ${values.length}, expected ${columns.length}` };
  }
  const map: Record<string, string> = {};
  for (let i = 0; i < columns.length; i++) {
    map[columns[i]!] = (values[i] ?? "").trim();
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
