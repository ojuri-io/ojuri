import { singleton } from "tsyringe";
import { RuntimeSetting, IRuntimeSetting } from "../model/runtime-setting.model";

@singleton()
class RuntimeSettingRepo {
  async list(): Promise<IRuntimeSetting[]> {
    const rows = await RuntimeSetting.query().orderBy("key");
    return rows.map((r) => r.toJSON()) as IRuntimeSetting[];
  }

  async findByKey(key: string): Promise<IRuntimeSetting | null> {
    const row = await RuntimeSetting.query().findOne({ key });
    return (row?.toJSON() as IRuntimeSetting) ?? null;
  }

  async updateByKey(
    key: string,
    value: string,
    updatedBy: string | null
  ): Promise<IRuntimeSetting | null> {
    const updated = await RuntimeSetting.query()
      .patch({ value, updatedBy })
      .where({ key })
      .returning("*")
      .first();
    return (updated?.toJSON() as IRuntimeSetting) ?? null;
  }
}

export default RuntimeSettingRepo;
