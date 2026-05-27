import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";

// Per-user timestamp the bell popover writes when the operator opens it.
// The unread-badge count is derived as "items whose source event has a
// createdAt later than this". NULL means the user has never opened the
// bell — every backlog item counts as unread on first sight. Updating
// this column is the only mutation the notifications module performs;
// the items themselves are still computed client-side from the same
// queue / reports / models / webhooks state the dashboard already loads.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.USERS, (table) => {
    table.timestamp("lastNotificationSeenAt", { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(DB_TABLES.USERS, (table) => {
    table.dropColumn("lastNotificationSeenAt");
  });
}
