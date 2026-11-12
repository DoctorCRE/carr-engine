import { Hono } from "hono";
import { sql } from "kysely";
import {
	DATABASE_UNAVAILABLE,
	type DatabaseEnv,
	readSnapshot,
} from "./reader.ts";

export const connection = new Hono<DatabaseEnv>();

connection.get("/database", async (c) => {
	const unavailable = () => c.json(DATABASE_UNAVAILABLE, 503);
	const database = c.env.DATABASE;
	if (!database) return unavailable();
	try {
		return c.json(
			await readSnapshot(database.connectionString, async (db) => {
				const { read_only, isolation, time_zone } = await db
					.selectNoFrom([
						sql<string>`current_setting('transaction_read_only')`.as(
							"read_only",
						),
						sql<string>`current_setting('transaction_isolation')`.as(
							"isolation",
						),
						sql<string>`current_setting('TimeZone')`.as("time_zone"),
					])
					.executeTakeFirstOrThrow();
				await sql`savepoint board`.execute(db);
				let board_view_readable = true;
				try {
					await sql`select 1 from v_open_deal_room_board limit 1`.execute(db);
				} catch {
					board_view_readable = false;
					await sql`rollback to savepoint board`.execute(db);
				}
				return {
					read_only: read_only === "on",
					isolation,
					time_zone,
					board_view_readable,
				};
			}),
		);
	} catch {
		return unavailable();
	}
});
