import Credentials from "../credentials.js";
import Transport from "../http/transport.js";
import { unwrapEnvelope } from "../http/envelope.js";
import { encodePathSegment } from "../http/path-segment.js";
import { RequestOptions } from "../client.types.js";
import {
  DecisionAuditRow,
  OverrideDecisionInput,
  RecentDecisionsQuery,
  ReviewQueuePage,
  ReviewQueueQuery,
} from "../types/decision.types.js";

class DecisionsResource {
  constructor(
    private readonly transport: Transport,
    private readonly credentials: Credentials
  ) {}

  async get(transactionId: string, options: RequestOptions = {}): Promise<DecisionAuditRow> {
    const segment = encodePathSegment("transactionId", transactionId);
    return this.read<DecisionAuditRow>(`/v1/decisions/${segment}`, {}, options);
  }

  async recent(
    query: RecentDecisionsQuery = {},
    options: RequestOptions = {}
  ): Promise<DecisionAuditRow[]> {
    const since = query.since instanceof Date ? query.since.toISOString() : query.since;
    return this.read<DecisionAuditRow[]>(
      "/v1/decisions/recent",
      { since, limit: query.limit },
      options
    );
  }

  async similar(
    auditId: string,
    query: { limit?: number } = {},
    options: RequestOptions = {}
  ): Promise<DecisionAuditRow[]> {
    const segment = encodePathSegment("auditId", auditId);
    return this.read<DecisionAuditRow[]>(
      `/v1/decisions/${segment}/similar`,
      { limit: query.limit },
      options
    );
  }

  async reviewQueue(
    query: ReviewQueueQuery = {},
    options: RequestOptions = {}
  ): Promise<ReviewQueuePage> {
    return this.read<ReviewQueuePage>(
      "/v1/review-queue",
      { limit: query.limit, offset: query.offset, order: query.order, search: query.search },
      options
    );
  }

  async override(
    auditId: string,
    input: OverrideDecisionInput,
    options: RequestOptions = {}
  ): Promise<DecisionAuditRow> {
    const response = await this.transport.request<unknown>({
      method: "POST",
      path: `/v1/decisions/${encodePathSegment("auditId", auditId)}/override`,
      body: input,
      retryable: false,
      headers: this.credentials.bearerHeaders(options.tenantId),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return unwrapEnvelope<DecisionAuditRow>(response.data);
  }

  private async read<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    options: RequestOptions
  ): Promise<T> {
    const response = await this.transport.request<unknown>({
      method: "GET",
      path,
      query,
      headers: this.credentials.bearerHeaders(options.tenantId),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return unwrapEnvelope<T>(response.data);
  }
}

export default DecisionsResource;
