/**
 * Transaction event from Kafka
 */
export interface TransactionEvent {
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  transaction_type: string;
  timestamp: number;
  fraud: boolean;
  fraud_probability: number;
  decision: string;
  device_fingerprint?: {
    browser?: string;
    os?: string;
    screen_resolution?: string;
  };
  processed_at: number;
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
