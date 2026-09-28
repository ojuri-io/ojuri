import "reflect-metadata";
import Fastify from "fastify";
import TrainingJobNotFoundError from "@shared/error/training-job-not-found.error";
import TrainingUploadOffsetMismatchError from "@shared/error/training-upload-offset-mismatch.error";
import DecisionPublishError from "@shared/error/decision-publish.error";
import AuditQueueBackpressureError from "@shared/error/audit-queue-backpressure.error";
import bootstrapApp from "../../src/bootstrap";

/**
 * The handler used to drop errorCode, so every typed error reached a client as
 * message text alone. These assert it arrives, because the point of setting a
 * code on fifteen error classes is that a caller can read it.
 */
async function respondTo(thrown: Error) {
  const app = Fastify({ logger: false });
  bootstrapApp(app);
  app.get("/boom", async () => {
    throw thrown;
  });
  const res = await app.inject({ method: "GET", url: "/boom" });
  await app.close();
  return { status: res.statusCode, body: res.json() };
}

describe("the error handler forwards a code", () => {
  it("carries the code for a not-found", async () => {
    const { status, body } = await respondTo(new TrainingJobNotFoundError("job-1"));

    expect(status).toBe(404);
    expect(body.code).toBe("training_job_not_found");
  });

  it("tells two different 409s apart", async () => {
    const offset = await respondTo(new TrainingUploadOffsetMismatchError(0, 10));

    expect(offset.status).toBe(409);
    expect(offset.code ?? offset.body.code).toBe("training_upload_offset_mismatch");
  });

  it("tells two different 503s apart", async () => {
    const publish = await respondTo(new DecisionPublishError("kafka down"));
    const backpressure = await respondTo(new AuditQueueBackpressureError(50_000));

    expect(publish.status).toBe(503);
    expect(backpressure.status).toBe(503);
    expect(publish.body.code).not.toBe(backpressure.body.code);
  });

  it("omits the code for an error that is not an AppError, rather than inventing one", async () => {
    const { status, body } = await respondTo(new Error("something unexpected"));

    expect(status).toBe(500);
    expect(body.code).toBeUndefined();
  });
});
