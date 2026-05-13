import { injectable } from "tsyringe";
import { BaseRepository } from "../../../v1/modules/moduleName/repositories/base.repo";
import { IRule, Rule } from "../model/rule.model";

@injectable()
class RuleRepo extends BaseRepository<IRule, Rule> {
  constructor() {
    super(Rule);
  }

  async listActiveOrdered(): Promise<Rule[]> {
    return Rule.query()
      .where({ isActive: true })
      .orderBy([
        { column: "priority", order: "asc" },
        { column: "createdAt", order: "asc" },
      ]);
  }

  async listAll(): Promise<Rule[]> {
    return Rule.query().orderBy([
      { column: "stage", order: "asc" },
      { column: "priority", order: "asc" },
    ]);
  }

  async patchById(id: string, patch: Partial<IRule>): Promise<Rule | undefined> {
    if (Object.keys(patch).length === 0) return Rule.query().findById(id);
    await Rule.query().where({ id }).patch(patch);
    return Rule.query().findById(id);
  }

  async deleteById(id: string): Promise<number> {
    return Rule.query().deleteById(id);
  }
}

export default RuleRepo;
