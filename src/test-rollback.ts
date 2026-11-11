import { after } from "node:test";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./database.d.ts";

const configured = process.env.TEST_DATABASE_URL;
if (!configured)
	throw new Error("Run npm run check to restore the test database first");
export const url = configured;
const db = new Kysely<DB>({
	dialect: new PostgresDialect({
		pool: new pg.Pool({
			connectionString: url,
			options: "-c TimeZone=America/Chicago",
		}),
	}),
});
after(() => db.destroy());

export async function withRollback(
	run: (tx: Transaction<DB>) => Promise<void>,
) {
	const tx = await db.startTransaction().execute();
	try {
		await sql`set local time zone 'UTC'`.execute(tx);
		await run(tx);
	} finally {
		await tx.rollback().execute();
	}
}
