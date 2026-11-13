import { sql } from "kysely";
import type { Reader } from "../reader.ts";

// A failed query, such as one the login has no grant for, answers null. Its
// savepoint keeps the answer's transaction able to commit.
export async function attempt<T>(db: Reader, read: () => Promise<T>) {
	await sql`savepoint attempt`.execute(db);
	try {
		const value = await read();
		await sql`release savepoint attempt`.execute(db);
		return value;
	} catch {
		await sql`rollback to savepoint attempt`.execute(db);
		return null;
	}
}

// The partner's published Outlook snapshot, or undefined when there is none
// or it could not be read, which every caller answers alike.
export async function storedSnapshot(db: Reader, partner: string) {
	const rows = await attempt(db, () =>
		db
			.selectFrom("board_snapshot")
			.select("snapshot_json")
			.where("organization_tenant_id", "=", "carr-internal")
			.where("sponsoring_human_slug", "=", partner)
			.where("board_id", "=", "calendar-agenda")
			.execute(),
	);
	return rows?.[0]?.snapshot_json;
}
