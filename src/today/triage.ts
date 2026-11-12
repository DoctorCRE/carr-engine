import { type Expression, type QueryCreator, sql } from "kysely";
import { isOneOf } from "../clients/read.ts";
import type { DB } from "../database.d.ts";
import type { Reader } from "../reader.ts";

export const OWNERS = ["all", "partners"] as const;
type Owners = (typeof OWNERS)[number];
const KINDS = [
	"next_action",
	"post_call_action",
	"critical_date",
	"ingest",
] as const;
type Rank = 0 | 1 | 2;
type After = {
	on: string;
	rank: Rank;
	due_on: string | null;
	item_kind: (typeof KINDS)[number];
	id: string;
};

// The owner slugs the old system counted as a partner's, local seats included.
const PARTNER_OWNERS = ["joe", "joe-local", "dell", "dell-local"];
// The view's columns in its order, which the old answer kept.
const COLUMNS = [
	"item_kind",
	"id",
	"subject_type",
	"subject_id",
	"owner",
	"what",
	"due_on",
	"subject_name",
	"subject_ref",
	"business_days_overdue",
] as const;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const isRank = (value: unknown): value is Rank =>
	value === 0 || value === 1 || value === 2;

const isDay = (value: unknown): value is string => {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
		value < "0001-01-01"
	)
		return false;
	const time = Date.parse(`${value}T00:00:00Z`);
	return (
		Number.isFinite(time) && new Date(time).toISOString().startsWith(value)
	);
};

// The old cursor is base64 JSON naming the page's day and its last row.
export function parseCursor(text: string, owners: Owners): After | undefined {
	if (text.length > 1000) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(atob(text));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const {
		v,
		owners: given,
		on,
		rank,
		due_on,
		item_kind,
		id,
	} = parsed as Record<string, unknown>;
	if (
		v !== 2 ||
		given !== owners ||
		!isDay(on) ||
		!isRank(rank) ||
		!(due_on === null || isDay(due_on)) ||
		typeof item_kind !== "string" ||
		!isOneOf(KINDS, item_kind) ||
		typeof id !== "string" ||
		!UUID.test(id)
	)
		return undefined;
	return { on, rank, due_on, item_kind, id };
}

// Due actions first, then critical dates due within 14 days, then the rest.
const rankOn = (on: string) => sql<Rank>`case
	when item_kind in ('next_action', 'post_call_action') and due_on <= ${on}::date then 0
	when item_kind = 'critical_date' and due_on between ${on}::date and ${on}::date + 14 then 1
	else 2 end`;

// Critical dates soonest first, everything else latest first, undated last.
const sortKey = (rank: Expression<number>, dueOn: Expression<unknown>) =>
	sql<number>`coalesce(case when ${rank} = 1 then 1 else -1 end * to_char(${dueOn}, 'J')::integer, 9999999)`;

const scoped = (db: QueryCreator<DB>, owners: Owners) =>
	db
		.selectFrom("v_today_triage")
		.$if(owners === "partners", (qb) =>
			qb.where((eb) =>
				eb.or([
					eb("owner", "is", null),
					eb(eb.fn("lower", ["owner"]), "in", PARTNER_OWNERS),
				]),
			),
		);

const pastCursor = (after: After) =>
	sql<boolean>`(rank, ${sortKey(sql.ref("rank"), sql.ref("due_on"))}, item_kind, id)
		> (${after.rank}::integer, ${sortKey(sql`${after.rank}::integer`, sql`${after.due_on}::date`)}, ${after.item_kind}, ${after.id}::uuid)`;

export async function readTodayTriage(
	db: Reader,
	{
		owners,
		limit,
		after,
	}: { owners: Owners; limit: number; after: After | null },
) {
	const on =
		after?.on ??
		(
			await db
				.selectNoFrom(sql<string>`current_date::text`.as("today"))
				.executeTakeFirstOrThrow()
		).today;
	const { total } = await scoped(db, owners)
		.select((eb) => eb.fn.countAll<string>().as("total"))
		.executeTakeFirstOrThrow();
	const rows = await db
		.with("ranked", (qb) =>
			scoped(qb, owners).select([...COLUMNS, rankOn(on).as("rank")]),
		)
		.selectFrom("ranked")
		.selectAll()
		.where(after ? pastCursor(after) : sql<boolean>`true`)
		.orderBy("rank")
		.orderBy(sortKey(sql.ref("rank"), sql.ref("due_on")))
		.orderBy("item_kind")
		.orderBy("id")
		.limit(limit + 1)
		.execute();
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const has_more = rows.length > limit;
	return {
		items: page.map(({ rank: _, ...item }) => item),
		total: Number(total),
		has_more,
		next_cursor:
			has_more && last
				? btoa(
						JSON.stringify({
							v: 2,
							owners,
							on,
							rank: last.rank,
							due_on: last.due_on,
							item_kind: last.item_kind,
							id: last.id,
						}),
					)
				: null,
	};
}
