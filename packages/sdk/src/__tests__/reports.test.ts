import OjuriClient from "../client.js";
import { stubFetch } from "./test-fetch.js";

const REPORT = { id: "rpt-1", transactionId: "txn-1", verdict: "FRAUD_CONFIRMED" };

describe("reports", () => {
  function client(stubs: Parameters<typeof stubFetch>[0]) {
    const stub = stubFetch(stubs);
    return {
      stub,
      client: new OjuriClient({
        baseUrl: "https://rda.example.com",
        fiaUrl: "https://fia.example.com",
        jwt: "jwt-token",
        fetch: stub.fetch,
      }),
    };
  }

  it("marks a freshly generated report as created", async () => {
    const { client: sdk } = client([{ status: 201, body: REPORT }]);

    await expect(sdk.reports!.create({ transaction_id: "txn-1" })).resolves.toEqual({
      report: REPORT,
      created: true,
    });
  });

  it("marks an idempotent 200 as not created", async () => {
    const { client: sdk } = client([{ status: 200, body: REPORT }]);

    await expect(sdk.reports!.create({ transaction_id: "txn-1" })).resolves.toMatchObject({
      created: false,
    });
  });

  it("routes report calls to the FIA origin, not RDA", async () => {
    const { client: sdk, stub } = client([{ body: { reports: [], total: 0, limit: 25, offset: 0 } }]);

    await sdk.reports!.list({ status: "GENERATED", limit: 50 });

    expect(stub.calls[0]!.url).toBe(
      "https://fia.example.com/v1/reports?limit=50&status=GENERATED"
    );
  });

  it("surfaces FIA's bare {error} body as the message", async () => {
    const { client: sdk } = client([{ status: 404, body: { error: "report not found" } }]);

    await expect(sdk.reports!.get("rpt-missing")).rejects.toMatchObject({
      status: 404,
      message: "report not found",
    });
  });
});
