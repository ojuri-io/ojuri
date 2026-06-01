import { Decision } from "@shared/enums/decision.enum";
import { TransactionEvent } from "@shared/kafka/kafka-producer";
import { PredictDecisionContext } from "../services/predict.types";

class TransactionEventFactory {
  static fromDecisionContext(ctx: PredictDecisionContext, auditId: string | null): TransactionEvent {
    const { request } = ctx;
    return {
      transaction_id: request.transaction_id,
      sender_id: request.sender_id,
      receiver_id: request.receiver_id,
      amount: request.amount,
      transaction_type: request.transaction_type,
      timestamp: request.timestamp,
      fraud: ctx.finalDecision === Decision.DECLINE,
      fraud_probability: ctx.mlScore,
      decision: ctx.finalDecision,
      decision_source: ctx.decisionSource,
      rule_name: ctx.rule?.rule.name ?? undefined,
      audit_id: auditId ?? undefined,
      device_fingerprint: request.device_fingerprint,
      processed_at: Date.now(),

      customer_dob: request.customer_dob,
      customer_nationality: request.customer_nationality,
      customer_type: request.customer_type,
      customer_id_type: request.customer_id_type,
      account_age_days: request.account_age_days,
      is_authenticated: request.is_authenticated,

      channel: request.channel,
      currency: request.currency,
      is_inflow: request.is_inflow,
      is_recurring: request.is_recurring,

      wallet_balance: request.wallet_balance,

      customer_latitude: request.customer_latitude,
      customer_longitude: request.customer_longitude,
      transaction_country: request.transaction_country,
      destination_country: request.destination_country,
      ip_country: request.ip_country,
      transaction_lat: request.transaction_lat,
      transaction_lng: request.transaction_lng,

      ip_is_vpn: request.ip_is_vpn,
      device_is_trusted: request.device_is_trusted,
      device_type: request.device_type,
      session_to_txn_seconds: request.session_to_txn_seconds,

      agent_id: request.agent_id,

      recipient_nationality: request.recipient_nationality,
      recipient_id_type: request.recipient_id_type,
      customer_fi: request.customer_fi,
      recipient_fi: request.recipient_fi,

      request_context: (request as unknown as Record<string, unknown>).request_context as
        | Record<string, unknown>
        | undefined,

      customer_account_name: request.customer_account_name,
      beneficiary_account_name: request.beneficiary_account_name,
    };
  }
}

export default TransactionEventFactory;
