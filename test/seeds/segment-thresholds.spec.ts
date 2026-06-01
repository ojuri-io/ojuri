import { TransactionType } from "../../src/shared/enums/transaction-type.enum";

describe("segment threshold seed contract", () => {
  it("CASH_OUT uses a stricter (higher) threshold than TRANSFER", async () => {
    const seedModule = await import("../../src/database/seeds/02_segment_thresholds");
    const exported = (seedModule as unknown as Record<string, unknown>).DEFAULT_THRESHOLDS;
    const inserts: { segment: string; threshold: number }[] = [];
    const fakeBuilder = {
      insert(row: { segment: string; threshold: number }) {
        inserts.push(row);
        return { onConflict: () => ({ merge: () => Promise.resolve() }) };
      },
      where: () => ({ first: () => Promise.resolve({ version: "v1.0" }) }),
    };
    const fakeKnex = ((table: string) => {
      void table;
      return fakeBuilder;
    }) as unknown as Parameters<typeof seedModule.seed>[0];
    (fakeKnex as unknown as { fn: { now: () => string } }).fn = { now: () => "now()" };
    await seedModule.seed(fakeKnex);

    const cashOut = inserts.find((r) => r.segment === TransactionType.CASH_OUT);
    const transfer = inserts.find((r) => r.segment === TransactionType.TRANSFER);
    expect(cashOut?.threshold).toBe(0.7);
    expect(transfer?.threshold).toBe(0.3);
    expect(cashOut!.threshold).toBeGreaterThan(transfer!.threshold);
    void exported;
  });
});
