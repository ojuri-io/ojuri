import type Redis from "ioredis";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import RedisClient from "@shared/redis-client/redis-client";
import { evaluate } from "./evaluator";
import RuleRepo from "./repositories/rule.repo";
import { Rule } from "./model/rule.model";
import { CreateRuleInput, RuleContext, RuleHit, RuleRecord, RuleStage, UpdateRuleInput } from "./rule.types";

const log = createServiceLogger("RulesService");

const RELOAD_INTERVAL_MS = Number(process.env.RULES_RELOAD_INTERVAL_MS) || 30_000;
const RULES_INVALIDATION_CHANNEL = "ojuri:rules:invalidate";

@singleton()
class RulesService {
  private preRules: RuleRecord[] = [];
  private postRules: RuleRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private subscriber: Redis | null = null;
  private loaded = false;

  constructor(private readonly repo: RuleRepo, private readonly redis: RedisClient) {}

  async initialize(): Promise<void> {
    await this.reload();

    try {
      this.subscriber = this.redis.get().duplicate();
      await this.subscriber.subscribe(RULES_INVALIDATION_CHANNEL);
      this.subscriber.on("message", (channel) => {
        if (channel !== RULES_INVALIDATION_CHANNEL) return;
        this.reload().catch((err) =>
          log.error("reload", "Pub/sub-triggered rules reload failed", { err: String(err) })
        );
      });
    } catch (err) {
      log.warn(
        "initialize",
        "Failed to subscribe to rules invalidation channel; falling back to timer-only reload",
        { err: String(err) }
      );
    }

    this.timer = setInterval(() => {
      this.reload().catch((err) =>
        log.error("reload", "Failed to reload rules", { err: String(err) })
      );
    }, RELOAD_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  private async publishInvalidation(): Promise<void> {
    try {
      await this.redis.get().publish(RULES_INVALIDATION_CHANNEL, "1");
    } catch (err) {
      log.warn("publishInvalidation", "Failed to broadcast rules invalidation", {
        err: String(err),
      });
    }
  }

  async reload(): Promise<void> {
    const rows = await this.repo.listActiveOrdered();

    const pre: RuleRecord[] = [];
    const post: RuleRecord[] = [];

    for (const row of rows) {
      const record = this.toRecord(row);
      if (record.stage === "PRE") pre.push(record);
      else post.push(record);
    }

    this.preRules = pre;
    this.postRules = post;
    this.loaded = true;

    log.debug("reload", "Rules reloaded", { pre: pre.length, post: post.length });
  }

  /** Snapshot of the in-memory cache. Used by the admin reload endpoint. */
  counts(): { pre: number; post: number } {
    return { pre: this.preRules.length, post: this.postRules.length };
  }

  async reloadAndBroadcast(): Promise<void> {
    await this.reload();
    await this.publishInvalidation();
  }

  evaluate(stage: RuleStage, ctx: RuleContext): RuleHit | null {
    const rules = stage === "PRE" ? this.preRules : this.postRules;
    for (const rule of rules) {
      if (rule.tenantId && ctx.tenant_id && rule.tenantId !== ctx.tenant_id) {
        continue;
      }
      try {
        if (evaluate(rule.expression, ctx)) {
          return { rule, stage };
        }
      } catch (err) {
        log.error("evaluate", "Rule expression failed to evaluate; skipping", {
          ruleId: rule.id,
          ruleName: rule.name,
          err: String(err),
        });
      }
    }
    return null;
  }

  async create(input: CreateRuleInput): Promise<Rule> {
    const row = await this.repo.save({
      name: input.name,
      description: input.description ?? null,
      stage: input.stage ?? "POST",
      priority: input.priority ?? 100,
      action: input.action,
      expression: input.expression,
      tenantId: input.tenantId ?? null,
      isActive: input.isActive ?? false,
      createdBy: input.createdBy ?? null,
    });
    await this.reload().catch((err) =>
      log.error("create", "Local rules reload after create failed", { err: String(err) })
    );
    await this.publishInvalidation();
    return row;
  }

  async list(): Promise<Rule[]> {
    return this.repo.listAll();
  }

  async update(id: string, patch: UpdateRuleInput): Promise<Rule | null> {
    const allowed: (keyof UpdateRuleInput)[] = [
      "name",
      "description",
      "stage",
      "priority",
      "action",
      "expression",
      "isActive",
    ];
    const fields: Partial<UpdateRuleInput> = {};
    for (const k of allowed) {
      if (k in patch) (fields as any)[k] = patch[k];
    }

    if (Object.keys(fields).length === 0) return null;

    const row = await this.repo.patchById(id, fields as any);
    await this.reload().catch((err) =>
      log.error("update", "Local rules reload after update failed", { err: String(err) })
    );
    await this.publishInvalidation();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const n = await this.repo.deleteById(id);
    if (n > 0) {
      await this.reload().catch((err) =>
        log.error("delete", "Local rules reload after delete failed", { err: String(err) })
      );
      await this.publishInvalidation();
    }
    return n > 0;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }

  private toRecord(row: Rule): RuleRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      stage: row.stage as RuleStage,
      priority: row.priority,
      action: row.action as RuleRecord["action"],
      expression:
        typeof row.expression === "string" ? JSON.parse(row.expression as unknown as string) : row.expression,
      isActive: row.isActive,
      tenantId: row.tenantId,
    };
  }
}

export default RulesService;
