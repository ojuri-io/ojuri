import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";

export interface TrainingJobStatusView {
  id: string;
  source: string;
  status: TrainingJobStatus;
  rowsRead: number;
  rowsStaged: number;
  rowsRejected: number;
  errors: TrainingRowError[] | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface TrainingRowError {
  row: number;
  message: string;
}

export interface TrainingTransformSpec {
  headerMap?: Record<string, string>;
  columnDefaults?: Record<string, string>;
  dropEmptyRows?: boolean;
}

export interface ParsedTransactionRow {
  transactionId: string;
  senderId: string;
  receiverId: string;
  amount: number;
  transactionType: string;
  timestamp: number;
  fraudLabel: boolean | null;
  groundTruthFraud: boolean | null;
  channel: string | null;
  currency: string | null;
  accountAgeDays: number | null;
  ipCountry: string | null;
  transactionCountry: string | null;
  sessionToTxnSeconds: number | null;
  deviceIsTrusted: boolean | null;
  isAuthenticated: boolean | null;
}
