import type { Kysely } from "kysely";
import type { DB } from "../database.d.ts";
import { asText } from "../reader.ts";

export const readCaptureQueue = async (db: Kysely<DB>) => ({
	candidates: await db
		.selectFrom("v_capture_candidate_queue")
		.select((eb) => [
			"id",
			"session_id",
			"kind",
			"payload",
			"evidence_quote",
			eb.cast<number>("confidence", "float8").as("confidence"),
			"deal_name",
			asText(eb.ref("created_at")).as("created_at"),
		])
		// Bare names sort by the output columns, as the old system did: the
		// float, then the timestamp's text.
		.orderBy("confidence", "desc")
		.orderBy("created_at")
		.orderBy("id")
		.execute(),
});
