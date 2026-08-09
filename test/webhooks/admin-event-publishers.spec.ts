import "reflect-metadata";
import { FastifyReply, FastifyRequest } from "fastify";
import ModelsController from "../../src/v1/modules/admin/controller/models.controller";
import RulesController from "../../src/v1/modules/admin/controller/rules.controller";
import { WebhookEvent } from "../../src/shared/enums/webhook-event.enum";
import { ModelStatus } from "../../src/shared/enums/model-status.enum";

// These two events were subscribable for several releases while nothing
// published them, so a subscriber could wait forever with no signal.
// These tests pin the publish sites, not the payload shape.

function fakeReply(): FastifyReply {
  const reply = {
    code: () => reply,
    send: (body: unknown) => body,
  } as unknown as FastifyReply;
  return reply;
}

describe("admin webhook publishers", () => {
  const modelRow = {
    version: "v9.9",
    sourceUri: "models/versions/v9.9/model.onnx",
    sha256: "deadbeef",
    defaultThreshold: 0.5,
    activatedAt: "2026-01-01T00:00:00.000Z",
  };

  function buildModelsController(publish: jest.Mock) {
    return new ModelsController(
      { setStatus: jest.fn().mockResolvedValue(modelRow) } as never,
      {} as never,
      { publish } as never
    );
  }

  function buildRulesController(publish: jest.Mock, row: Record<string, unknown>) {
    return new RulesController(
      {
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      } as never,
      { publish } as never
    );
  }

  it("publishes model.activated when a version is promoted to ACTIVE", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const controller = buildModelsController(publish);

    await controller.setStatus(
      { params: { version: "v9.9" }, body: { status: ModelStatus.ACTIVE } } as FastifyRequest<never>,
      fakeReply()
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe(WebhookEvent.MODEL_ACTIVATED);
    expect(publish.mock.calls[0][1]).toMatchObject({ version: "v9.9" });
  });

  it("does not publish when a version moves to a non-ACTIVE status", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const controller = buildModelsController(publish);

    await controller.setStatus(
      { params: { version: "v9.9" }, body: { status: ModelStatus.RETIRED } } as FastifyRequest<never>,
      fakeReply()
    );

    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes rule.activated when a rule is created active", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const row = { id: "r1", name: "demo", stage: "PRE", action: "DENY", priority: 10, isActive: true };
    const controller = buildRulesController(publish, row);

    await controller.create({ body: {}, auth: { username: "admin" } } as FastifyRequest<never>, fakeReply());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe(WebhookEvent.RULE_ACTIVATED);
    expect(publish.mock.calls[0][1]).toMatchObject({ rule_id: "r1" });
  });

  it("does not publish when a rule is created inactive", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const row = { id: "r1", name: "demo", stage: "PRE", action: "DENY", priority: 10, isActive: false };
    const controller = buildRulesController(publish, row);

    await controller.create({ body: {}, auth: { username: "admin" } } as FastifyRequest<never>, fakeReply());

    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes rule.activated only on the transition into active", async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const row = { id: "r1", name: "demo", stage: "PRE", action: "DENY", priority: 10, isActive: true };
    const controller = buildRulesController(publish, row);

    await controller.update(
      { params: { id: "r1" }, body: { isActive: true } } as FastifyRequest<never>,
      fakeReply()
    );
    expect(publish).toHaveBeenCalledTimes(1);

    publish.mockClear();
    await controller.update(
      { params: { id: "r1" }, body: { priority: 20 } } as FastifyRequest<never>,
      fakeReply()
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not let a failing subscriber break the admin call", async () => {
    const publish = jest.fn().mockRejectedValue(new Error("subscriber exploded"));
    const controller = buildModelsController(publish);

    await expect(
      controller.setStatus(
        { params: { version: "v9.9" }, body: { status: ModelStatus.ACTIVE } } as FastifyRequest<never>,
        fakeReply()
      )
    ).resolves.toBeDefined();
  });
});
