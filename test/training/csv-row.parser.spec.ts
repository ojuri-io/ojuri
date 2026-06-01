import { parseCsvHeader, parseCsvRow } from "../../src/v1/modules/training/services/csv-row.parser";

describe("csv-row parser", () => {
  const header = "transactionId,senderId,receiverId,amount,transactionType,timestamp,groundTruthFraud,channel";
  const columns = parseCsvHeader(header).columns;

  it("accepts a well-formed row with optional columns", () => {
    const { row, error } = parseCsvRow(
      columns,
      "tx-1,s,r,42.50,PAYMENT,1700000000000,true,MOBILE",
    );
    expect(error).toBeNull();
    expect(row).toMatchObject({
      transactionId: "tx-1",
      senderId: "s",
      amount: 42.5,
      transactionType: "PAYMENT",
      timestamp: 1700000000000,
      groundTruthFraud: true,
      channel: "MOBILE",
    });
  });

  it("rejects a row with non-numeric amount", () => {
    const { row, error } = parseCsvRow(
      columns,
      "tx-2,s,r,not-a-number,PAYMENT,1700000000000,false,",
    );
    expect(row).toBeNull();
    expect(error).toMatch(/amount/);
  });

  it("rejects when column count mismatches header", () => {
    const { row, error } = parseCsvRow(columns, "tx-3,s,r,10,PAYMENT,1700000000000");
    expect(row).toBeNull();
    expect(error).toMatch(/column count/);
  });

  it("rejects when a required column is empty", () => {
    const { row, error } = parseCsvRow(
      columns,
      "tx-4,,r,10,PAYMENT,1700000000000,false,",
    );
    expect(row).toBeNull();
    expect(error).toMatch(/missing required column/);
  });

  it("reports missing required header columns", () => {
    const { missing } = parseCsvHeader("transactionId,senderId,amount");
    expect(missing).toEqual(expect.arrayContaining(["receiverId", "transactionType", "timestamp"]));
  });
});
