import Credentials from "../credentials.js";
import Transport from "../http/transport.js";
import { encodePathSegment } from "../http/path-segment.js";
import { RequestOptions } from "../client.types.js";
import {
  CreateReportInput,
  CreateReportResult,
  InvestigationReport,
  ListReportsQuery,
  MessageResult,
  ReportsPage,
} from "../types/report.types.js";

// LLM generation dominates every write path here — the client default would
// abort a healthy report mid-flight.
const LLM_TIMEOUT_MS = 180_000;

class ReportsResource {
  constructor(
    private readonly transport: Transport,
    private readonly credentials: Credentials
  ) {}

  async create(
    input: CreateReportInput,
    options: RequestOptions = {}
  ): Promise<CreateReportResult> {
    const response = await this.transport.request<InvestigationReport>({
      method: "POST",
      path: "/v1/reports",
      body: input,
      headers: this.credentials.bearerHeaders(options.tenantId),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? LLM_TIMEOUT_MS,
    });
    return { report: response.data, created: response.status === 201 };
  }

  async get(reportId: string, options: RequestOptions = {}): Promise<InvestigationReport> {
    const response = await this.transport.request<InvestigationReport>({
      method: "GET",
      path: `/v1/reports/${encodePathSegment("reportId", reportId)}`,
      headers: this.credentials.bearerHeaders(options.tenantId),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return response.data;
  }

  async list(query: ListReportsQuery = {}, options: RequestOptions = {}): Promise<ReportsPage> {
    const response = await this.transport.request<ReportsPage>({
      method: "GET",
      path: "/v1/reports",
      query: {
        limit: query.limit,
        offset: query.offset,
        status: query.status,
        verdict: query.verdict,
        search: query.search,
      },
      headers: this.credentials.bearerHeaders(options.tenantId),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return response.data;
  }

  async message(
    reportId: string,
    content: string,
    options: RequestOptions = {}
  ): Promise<MessageResult> {
    const response = await this.transport.request<MessageResult>({
      method: "POST",
      path: `/v1/reports/${encodePathSegment("reportId", reportId)}/messages`,
      body: { content },
      headers: this.credentials.bearerHeaders(options.tenantId),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? LLM_TIMEOUT_MS,
    });
    return response.data;
  }
}

export default ReportsResource;
