import { Decision } from "../enums/decision.enum.js";
import { ReportStatus } from "../enums/report-status.enum.js";
import { TransactionType } from "../enums/transaction-type.enum.js";

export interface CreateReportInput {
  transaction_id: string;
  sender_id?: string;
  receiver_id?: string;
  amount?: number;
  transaction_type?: `${TransactionType}`;
  fraud_probability?: number;
  decision?: `${Decision}`;
  timestamp?: number;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  llm_model_version?: string;
  latency_ms?: number;
}

export interface InvestigationReport {
  report_id: string;
  transaction_id: string;
  verdict: string;
  narrative: string;
  recommended_action: string;
  key_indicators: unknown;
  status: `${ReportStatus}`;
  conversation?: ConversationTurn[];
  [key: string]: unknown;
}

export interface CreateReportResult {
  report: InvestigationReport;
  /** False when an existing report was returned (HTTP 200) rather than generated (201). */
  created: boolean;
}

export interface MessageResult {
  report_id: string;
  user_turn: ConversationTurn;
  assistant_turn: ConversationTurn;
}

export interface ListReportsQuery {
  limit?: number;
  offset?: number;
  status?: `${ReportStatus}`;
  verdict?: string;
  search?: string;
}

export interface ReportsPage {
  reports: InvestigationReport[];
  total: number;
  limit: number;
  offset: number;
}
