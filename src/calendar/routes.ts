import { Hono } from "hono";
import { answer, checkFields, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readMeetingPrep } from "./meeting-prep.ts";

export const calendar = new Hono<DatabaseEnv>();

// The old tool took no input, so its door refused any field before the tool's
// own checks could run.
calendar.get("/calendar-meeting-prep", async (c) => {
	const refused = checkFields(new URL(c.req.url).searchParams, []);
	if (refused) return refuse(c, refused);
	return answer(c, "calendar-meeting-prep", (db) =>
		readMeetingPrep(db, c.get("partner").slug),
	);
});
