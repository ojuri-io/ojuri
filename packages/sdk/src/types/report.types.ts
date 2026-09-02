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

// FIA selects quoted column names, so persisted rows come back camelCase even
// though the request bodies it accepts are snake_case.
export interface ConversationTurn {
  id: string;
  turn_index: number;
  role: "user" | "assistant";
  content: string;
  llmModelVersion: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface InvestigationReportSummary {
  id: string;
  transactionId: string;
  senderId: string;
  amount: string | number;
  transactionType: `${TransactionType}` | null;
  verdict: string;
  recommendedAction: string;
  agentConfidence: number | null;
  status: `${ReportStatus}`;
  createdAt: string;
}

export interface InvestigationReport extends InvestigationReportSummary {
  receiverId: string | null;
  mlFraudProbability: number | null;
  mlDecision: `${Decision}` | null;
  narrative: string;
  keyIndicators: unknown;
  featuresSnapshot: Record<string, number> | null;
  llmModelVersion: string | null;
  promptTemplateVersion: string | null;
  generationLatencyMs: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  conversation: ConversationTurn[];
}

export interface CreateReportResult {
  report: InvestigationReport;
  /** False when an existing report was returned (HTTP 200) rather than generated (201). */
  created: boolean;
}

// The messages endpoint builds its own payload rather than returning persisted
// rows, so these turns are snake_case throughout, unlike ConversationTurn.
export interface MessageTurn {
  role: "user" | "assistant";
  content: string;
  llm_model_version?: string;
  latency_ms?: number;
}

export interface MessageResult {
  report_id: string;
  user_turn: MessageTurn;
  assistant_turn: MessageTurn;
}

export interface ListReportsQuery {
  limit?: number;
  offset?: number;
  status?: `${ReportStatus}`;
  verdict?: string;
  search?: string;
}

export interface ReportsPage {
  reports: InvestigationReportSummary[];
  total: number;
  limit: number;
  offset: number;
}
