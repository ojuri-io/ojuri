/**
 * Transaction event from Kafka.
 *
 * Mirrors RDA's `KafkaProducer.TransactionEvent`. The optional context
 * block is everything PAA persists into `transactions` so MLA can train
 * on it. Pre-2026-05 events without these fields parse fine — missing
 * values map to NULL.
 */
export interface TransactionEvent {
  // ── Core ────────────────────────────────────────────────────
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  transaction_type: string;
  timestamp: number;
  fraud: boolean;
  fraud_probability: number;
  decision: string;
  /**
   * What drove the decision: "ML", "PRE_RULE", or "POST_RULE". MLA
   * filters on this to avoid training on rule-driven DECLINEs (which
   * would otherwise teach the next model to mimic the rules).
   * Optional for backward compatibility with pre-rules-engine events.
   */
  decision_source?: string;
  /** Human-readable rule name when decision_source is a rule. */
  rule_name?: string;
  /** Optional audit row id, for tracing back to decisionAuditLog. */
  audit_id?: string;
  device_fingerprint?: {
    browser?: string;
    os?: string;
    screen_resolution?: string;
  };
  processed_at: number;

  // ── Optional request context (DTO mirror) ────────────────────
  customer_dob?: string;
  customer_nationality?: string;
  customer_type?: string;
  customer_id_type?: string;
  account_age_days?: number;
  is_authenticated?: boolean;
  channel?: string;
  currency?: string;
  is_inflow?: boolean;
  is_recurring?: boolean;
  wallet_balance?: number;
  customer_latitude?: number;
  customer_longitude?: number;
  transaction_country?: string;
  destination_country?: string;
  ip_country?: string;
  transaction_lat?: number;
  transaction_lng?: number;
  ip_is_vpn?: boolean;
  device_is_trusted?: boolean;
  device_type?: string;
  session_to_txn_seconds?: number;
  agent_id?: string;
  recipient_nationality?: string;
  recipient_id_type?: string;
  customer_fi?: string;
  recipient_fi?: string;
  request_context?: Record<string, unknown>;

  // ── Display names (added 2026-05) ────────────────────────────
  customer_account_name?: string;
  beneficiary_account_name?: string;
}

/**
 * Network centrality features for a user
 */
export interface NetworkFeatures {
  pagerank: number;
  clusteringCoef: number;
  communityId: number;
  degreeCentrality: number;
  inDegree: number;
  outDegree: number;
}

/**
 * Per-user node state in the transaction graph. Mirrors the
 * non-metric attributes of graphology's NodeAttributes so PAA can
 * snapshot a node's history independently of the (more expensive)
 * PageRank/Louvain recompute.
 */
export interface NodeState {
  firstSeen: number;
  lastSeen: number;
  transactionCount: number;
  totalAmount: number;
}

/**
 * Combined node snapshot (state + metrics) persisted to graphMetadata.
 */
export interface NodeSnapshot extends NetworkFeatures, NodeState {}

/**
 * Directed edge snapshot persisted to transactionEdges. Drives
 * boot-time graph hydration so restarts retain the edge structure
 * older than the transactions replay window.
 */
export interface EdgeSnapshot {
  senderId: string;
  receiverId: string;
  weight: number;
  totalAmount: number;
  firstTransaction: number;
  lastTransaction: number;
  transactionTypes: string[];
}

/**
 * Velocity metrics for a user
 */
export interface VelocityMetrics {
  velocity_1h: number;
  velocity_24h: number;
  velocity_7d: number;
  avg_amount_30d: number;
  std_amount_30d: number;
  time_since_last_txn: number;
}

/**
 * Combined features to store in Redis
 */
export interface CombinedFeatures extends VelocityMetrics, NetworkFeatures {
  updated_at: number;
}
