import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CLIENT = id(1);
const AGENT = id(2);
const PROPERTY = id(3);
const ELSEWHERE = id(4);
const DEAL = id(5);
const MISSING = id(99);
const LENDERS = [id(6), id(7)];
const LENDER_DEAL = id(8);
const BROKERAGES = [id(9), id(10)];
const EMAIL = id(300);
const CALL = id(301);
const NOTE = id(302);

const SEED = `
insert into role (slug, label) values
	('client', 'Client'), ('listing_agent', 'Listing agent'), ('lender', 'Lender');
insert into party (id, kind, name) values
	('${CLIENT}', 'company', 'Example Dental Group'), ('${AGENT}', 'person', 'Avery Example'),
	('${LENDERS[0]}', 'company', 'Example Bank'), ('${LENDERS[1]}', 'company', 'Example Credit Union'),
	('${BROKERAGES[0]}', 'company', 'Example Realty'), ('${BROKERAGES[1]}', 'company', 'Example Properties');
insert into party_role values ('${CLIENT}', 'client'), ('${AGENT}', 'listing_agent');
insert into party_company (person_id, company_id, title, started_on, ended_on) values
	('${AGENT}', '${BROKERAGES[0]}', 'Associate', '2020-01-06', '2025-12-31'),
	('${AGENT}', '${BROKERAGES[1]}', 'Senior associate', '2026-01-05', null);
insert into phase (slug, label) values ('negotiation', 'Negotiating'), ('legal', 'Legal'), ('dead', 'Dead');
insert into property (id, address) values
	('${PROPERTY}', '100 Example Way, Springfield'), ('${ELSEWHERE}', '200 Example Way, Springfield');
insert into deal (id, name) values
	('${DEAL}', 'Example Dental Springfield Deal'), ('${LENDER_DEAL}', 'Example Loan Deal');
insert into deal_property values ('${DEAL}', '${PROPERTY}');
insert into deal_party values ('${DEAL}', '${CLIENT}', 'client'), ('${DEAL}', '${AGENT}', 'listing_agent');
insert into deal_phase_change values
	('${DEAL}', '2026-03-02T15:00:00+00:00', 'negotiation', null),
	('${DEAL}', '2026-03-20T15:00:00+00:00', 'legal', 'LOI accepted');
insert into activity (id, kind, happened_at, from_party_id, summary) values
	('${EMAIL}', 'email', '2026-03-09T14:00:00+00:00', '${AGENT}', null),
	('${CALL}', 'call', '2026-03-10T16:00:00+00:00', '${CLIENT}', 'Example asks for a shorter term'),
	('${NOTE}', 'note', '2026-03-11T16:00:00+00:00', null, 'Example prefers mornings');
insert into email (activity_id, message_id, sender, subject, body) values
	('${EMAIL}', '<counter-2@example.com>', 'avery@example.com', 'Counter to your LOI', 'Our counter is attached.');
insert into activity_about (activity_id, deal_id, party_id) values
	('${EMAIL}', '${DEAL}', null), ('${EMAIL}', null, '${AGENT}'),
	('${CALL}', '${DEAL}', null), ('${NOTE}', null, '${CLIENT}');
insert into next_step (id, what, owner_party_id, due_on, done_at, deal_id, party_id) values
	('${id(400)}', 'Start the lease draft', null, '2026-03-20', null, '${DEAL}', null),
	('${id(401)}', 'Send the signed LOI', '${CLIENT}', '2026-03-13', '2026-03-13T18:00:00+00:00', '${DEAL}', null),
	('${id(402)}', 'Ask about a second location', null, null, null, null, '${CLIENT}');
`;
const phases = [
	{
		changed_at: "2026-03-02T15:00:00+00:00",
		phase: "negotiation",
		reason: null,
	},
	{
		changed_at: "2026-03-20T15:00:00+00:00",
		phase: "legal",
		reason: "LOI accepted",
	},
];

// Our LOI, the landlord's counter, our response, and their acceptance of it.
// biome-ignore format: one row per round
const ROUNDS = [
	["client", CLIENT, "2026-03-02", "countered", 32, 9, 60, 40, 3, "2026-07-01", null, null],
	["listing_agent", AGENT, "2026-03-09", "countered", 34.5, 9.5, 84, 25, 2, null, 90, null],
	["client", CLIENT, "2026-03-12", "accepted", 33.5, 9.5, 84, 30, 2, null, 90, "Example exclusive use"],
] as const;
const rounds = ROUNDS.map(
	(
		[
			from_role,
			from_party_id,
			day,
			status,
			rent,
			nnn,
			term,
			ti,
			free,
			start,
			days,
			other,
		],
		i,
	) => ({
		id: id(100 + i),
		property_id: PROPERTY,
		round: i + 1,
		answers_round: i || null,
		from_party_id,
		from_role,
		offered_at: `${day}T15:00:00+00:00`,
		status,
		rent_per_sf_yr: rent,
		nnn_per_sf_yr: nnn,
		term_months: term,
		ti_per_sf: ti,
		free_rent_months: free,
		escalation_pct: 3,
		commencement_on: start,
		commencement_days_after_delivery: days,
		other_terms: other,
		documents: [
			{
				id: id(200 + i),
				name: `LOI round ${i + 1}.pdf`,
				r2_key: `example/loi-${i + 1}.pdf`,
				// The counter arrived as an attachment to the agent's email.
				email_activity_id: i === 1 ? EMAIL : null,
			},
		],
	}),
);

const offer = (
	round: number,
	answers: number,
	from: string,
	role: string,
	terms: Record<string, string | number> = {},
) => {
	const row = { property_id: PROPERTY, rent_per_sf_yr: 30, ...terms };
	return `insert into offer (deal_id, round, answers_round, from_party_id, from_role, offered_at, ${Object.keys(row)})
	values ('${DEAL}', ${round}, ${answers}, '${from}', '${role}', now(), ${Object.values(row).map((value) => `'${value}'`)})`;
};
const NEXT_ROUND = offer(4, 3, AGENT, "listing_agent");
// Runs the checks commit would run, inside a transaction the test still rolls back.
// Later statements in the transaction are then checked as they run.
const CHECK_AT_COMMIT = "set constraints all immediate";
const newEmail = (activity: string, messageId = `<${activity}@example.com>`) =>
	`insert into activity (id, kind, happened_at) values ('${activity}', 'email', now());
	insert into email (activity_id, message_id, sender, subject, body)
	values ('${activity}', '${messageId}', 'avery@example.com', 'Example', 'Example')`;
const linkedEmail = (activity: string) =>
	`${newEmail(activity)}; insert into activity_about (activity_id, property_id) values ('${activity}', '${PROPERTY}'); ${CHECK_AT_COMMIT}`;
const TERMS = [
	"rent_per_sf_yr",
	"nnn_per_sf_yr",
	"term_months",
	"ti_per_sf",
	"free_rent_months",
	"escalation_pct",
	"commencement_days_after_delivery",
];

const PARTNER = id(20);
const LINKEDIN = id(500);
const X = id(501);
const INSTAGRAM = id(502);
const RENT_IDEA = id(510);
const CHECKLIST_IDEA = id(511);
const STAT_CARD = id(520);
const PHOTO = id(521);
const post = (n: number) => id(530 + n);
const POST_ROWS = [
	[1, LINKEDIN, RENT_IDEA, STAT_CARD, "2026-06-01", "published"],
	[2, LINKEDIN, CHECKLIST_IDEA, PHOTO, "2026-06-03", "published"],
	[3, LINKEDIN, RENT_IDEA, PHOTO, "2026-06-05", "published"],
	[4, X, CHECKLIST_IDEA, STAT_CARD, "2026-06-02", "published"],
	[5, X, RENT_IDEA, null, "2026-06-20", "published"],
	[6, X, CHECKLIST_IDEA, null, "2026-06-04", "published"],
	[7, X, RENT_IDEA, STAT_CARD, "2026-06-06", "failed"],
	[8, LINKEDIN, CHECKLIST_IDEA, PHOTO, "2026-06-30", "scheduled"],
	[9, INSTAGRAM, CHECKLIST_IDEA, PHOTO, "2026-06-07", "published"],
	[10, INSTAGRAM, RENT_IDEA, STAT_CARD, "2026-06-08", "published"],
] as const;
// Hours after publishing and the numbers read then; null was not measured.
const READINGS: [number, number, Record<string, number | null>][] = [
	[1, 48, { views: 500, reactions: 10, comments: 2, shares: 1 }],
	[1, 168, { views: 1000, reactions: 30, comments: 10, shares: 10 }],
	[1, 336, { views: 2000, reactions: 100, comments: 20, shares: 10 }],
	[2, 168, { views: 1000, reactions: 40, comments: 20, shares: 10, clicks: 3 }],
	[3, 48, { views: 1000, reactions: 20, comments: 5, shares: 2 }],
	[3, 168, { views: 2000, reactions: null, comments: 10, shares: 5 }],
	[4, 160, { views: 500 }],
	[4, 166, { reactions: 10, comments: 5, shares: 5 }],
	[5, 72, { views: 800, reactions: 40, comments: 0, shares: 0 }],
	[6, 168, { views: 0, reactions: 0, comments: 0, shares: 0 }],
	[9, 168, { views: 1000, reactions: 50, comments: 10, shares: 5, saves: 25 }],
	[10, 168, { views: 1000, reactions: 10, comments: 0, shares: 0 }],
];
const MARKETING_SEED = `
insert into party (id, kind, name) values ('${PARTNER}', 'person', 'Jordan Example');
insert into social_account (id, platform, owner_party_id, handle) values
	('${LINKEDIN}', 'linkedin', '${PARTNER}', 'jordan-example'), ('${X}', 'x', '${PARTNER}', 'jordanexample'),
	('${INSTAGRAM}', 'instagram', '${PARTNER}', 'jordan.example');
insert into idea (id, angle, hook, pillar) values
	('${RENT_IDEA}', 'Example rents rose this year', 'number', 'local_market'),
	('${CHECKLIST_IDEA}', 'Five example lease questions', 'checklist', 'education');
insert into design_template (id, name) values ('${STAT_CARD}', 'Example stat card'), ('${PHOTO}', 'Example photo backdrop');
insert into post (id, social_account_id, platform, idea_id, design_template_id, scheduled_at, status, platform_post_id, published_at)
values ${POST_ROWS.map(
	([n, account, idea, template, day, status]) =>
		`('${post(n)}', '${account}', (select platform from social_account where id = '${account}'), '${idea}',
		${template && `'${template}'`}, '${day}T15:00:00+00:00', '${status}', ${
			status === "published"
				? `'example-${n}', '${day}T15:00:00+00:00'`
				: "null, null"
		})`,
)};
insert into measurement (post_id, platform, metric, taken_at, source, value, not_measured_reason)
select p.id, p.platform, r.metric, p.published_at + make_interval(hours => r.hours), 'example_source', r.value,
	case when r.value is null then 'Example: no number came back' end
from post p join (values ${READINGS.flatMap(([n, hours, values]) =>
	Object.entries(values).map(
		([metric, value]) =>
			`('${post(n)}'::uuid, ${hours}, '${metric}', ${value}::bigint)`,
	),
)}) r (post_id, hours, metric, value) on r.post_id = p.id;
`;
const newPost = (row: Record<string, string>) => {
	const post = {
		social_account_id: X,
		platform: "x",
		scheduled_at: "2026-06-09",
		...row,
	};
	return `insert into post (${Object.keys(post)}) values (${Object.values(post).map((value) => `'${value}'`)})`;
};
const newReading = (
	value: string,
	reason = "null",
	metric = "views",
	platform = "linkedin",
) =>
	`insert into measurement (post_id, platform, metric, taken_at, source, value, not_measured_reason)
	values ('${post(1)}', '${platform}', '${metric}', now(), 'example_source', ${value}, ${reason})`;

const RULES: Record<string, [sql: string, constraint: string][]> = {
	"a link to a record that does not exist is refused": [
		[
			`insert into deal_party values ('${DEAL}', '${MISSING}', 'client')`,
			"deal_party_party_id_fkey",
		],
		[newPost({ idea_id: MISSING }), "post_idea_id_fkey"],
		[`delete from party where id = '${AGENT}'`, "party_role_party_id_fkey"],
	],
	"the role list refuses a role it does not hold": [
		[
			`insert into party_role values ('${AGENT}', 'mayor')`,
			"party_role_role_fkey",
		],
		[
			`insert into deal_party values ('${DEAL}', '${AGENT}', 'mayor')`,
			"deal_party_role_fkey",
		],
	],
	"the same link is stored once": [
		[
			`insert into deal_party values ('${DEAL}', '${AGENT}', 'listing_agent')`,
			"deal_party_pkey",
		],
	],
	"a person or company has a known kind": [
		[
			"insert into party (kind, name) values ('household', 'Example')",
			"party_kind_check",
		],
	],
	"a person works at a company, ending no earlier than they started, linked once":
		[
			[
				`insert into party_company (person_id, company_id) values ('${CLIENT}', '${BROKERAGES[0]}')`,
				"party_company_person_id_person_kind_fkey",
			],
			[
				`insert into party_company (person_id, company_id) values ('${AGENT}', '${AGENT}')`,
				"party_company_company_id_company_kind_fkey",
			],
			[
				`insert into party_company (person_id, company_id, started_on, ended_on)
				values ('${AGENT}', '${BROKERAGES[0]}', '2026-02-02', '2026-02-01')`,
				"party_company_check",
			],
			[
				`insert into party_company (person_id, company_id, started_on) values ('${AGENT}', '${BROKERAGES[0]}', '2020-01-06')`,
				"party_company_person_id_company_id_started_on_key",
			],
			[
				`insert into party_company (person_id, company_id)
				values ('${AGENT}', '${CLIENT}'), ('${AGENT}', '${CLIENT}')`,
				"party_company_person_id_company_id_started_on_key",
			],
		],
	"a deal's phase history is kept, comes from the phase list, and a dead deal says why":
		[
			[
				`insert into deal_phase_change values ('${DEAL}', now(), 'dead', null)`,
				"deal_phase_change_dead_has_reason",
			],
			[
				`insert into deal_phase_change values ('${DEAL}', now(), 'paused', null)`,
				"deal_phase_change_phase_fkey",
			],
			[
				"update deal_phase_change set reason = 'Example'",
				"deal_phase_change_keeps_history",
			],
			["delete from deal_phase_change", "deal_phase_change_keeps_history"],
			["truncate deal_phase_change", "deal_phase_change_keeps_history"],
		],
	"a round number is used once per deal and answers an earlier round": [
		[offer(3, 2, AGENT, "listing_agent"), "offer_deal_id_round_key"],
		[offer(4, 4, AGENT, "listing_agent"), "offer_answers_earlier_round"],
		[offer(9, 8, AGENT, "listing_agent"), "offer_deal_id_answers_round_fkey"],
	],
	"a round comes from someone on the deal about a property it is considering": [
		[
			offer(4, 3, CLIENT, "listing_agent"),
			"offer_deal_id_from_party_id_from_role_fkey",
		],
		[
			offer(4, 3, AGENT, "listing_agent", { property_id: ELSEWHERE }),
			"offer_deal_id_property_id_fkey",
		],
	],
	"a round's terms are never negative": TERMS.map((term) => [
		offer(4, 3, AGENT, "listing_agent", { [term]: -1 }),
		`offer_${term}_check`,
	]),
	"rent starts on a date or a number of days after delivery, never both": [
		[
			offer(4, 3, AGENT, "listing_agent", {
				commencement_on: "2026-09-01",
				commencement_days_after_delivery: 90,
			}),
			"offer_commencement_date_or_days",
		],
	],
	"an activity is an email, call, meeting or note, and each about link names one record once":
		[
			[
				"insert into activity (kind, happened_at) values ('fax', now())",
				"activity_kind_check",
			],
			[
				`insert into activity_about (activity_id, deal_id, party_id) values ('${CALL}', '${DEAL}', '${CLIENT}')`,
				"activity_about_one_record",
			],
			[
				`insert into activity_about (activity_id) values ('${CALL}')`,
				"activity_about_one_record",
			],
			[
				`insert into activity_about (activity_id, deal_id) values ('${CALL}', '${DEAL}')`,
				"activity_about_activity_id_deal_id_party_id_property_id_key",
			],
		],
	"an email is stored once, belongs to an email activity, and is about a record":
		[
			[newEmail(id(303), "<counter-2@example.com>"), "email_message_id_key"],
			[newEmail(id(303), " <padded@example.com>"), "email_message_id_check"],
			[
				`insert into email (activity_id, message_id, sender, subject, body)
				values ('${CALL}', '<call@example.com>', 'avery@example.com', 'Example', 'Example')`,
				"email_activity_id_activity_kind_fkey",
			],
			[
				`insert into document (name, r2_key, email_activity_id) values ('Example.pdf', 'example/x.pdf', '${CALL}')`,
				"document_email_activity_id_fkey",
			],
			[`${newEmail(id(303))}; ${CHECK_AT_COMMIT}`, "email_about_a_record"],
			[
				`delete from activity_about where activity_id = '${EMAIL}'; ${CHECK_AT_COMMIT}`,
				"email_about_a_record",
			],
			["truncate activity_about", "email_about_a_record"],
			["truncate email cascade", "offer_document_keeps_history"],
			[
				`${linkedEmail(id(303))}; update activity_about set activity_id = '${CALL}' where activity_id = '${id(303)}'`,
				"email_about_a_record",
			],
			[
				`insert into activity (id, kind, happened_at) values ('${id(304)}', 'email', now());
				${linkedEmail(id(303))}; update email set activity_id = '${id(304)}' where activity_id = '${id(303)}'`,
				"email_about_a_record",
			],
		],
	"a next step is about exactly one record": [
		[
			`insert into next_step (what, deal_id, party_id) values ('Example', '${DEAL}', '${CLIENT}')`,
			"next_step_one_record",
		],
		["insert into next_step (what) values ('Example')", "next_step_one_record"],
	],
	"a round is never rewritten or removed, and one round per deal is accepted": [
		[
			"update offer set rent_per_sf_yr = 30 where round = 1",
			"offer_keeps_history",
		],
		["delete from offer where round = 3", "offer_keeps_history"],
		["truncate offer cascade", "offer_keeps_history"],
		[
			`${NEXT_ROUND}; update offer set status = 'accepted' where round = 4`,
			"offer_one_accepted_per_deal",
		],
	],
	"a round's status moves only out of open, or from accepted to superseded": [
		[
			"update offer set status = 'accepted' where round = 1",
			"offer_status_moves",
		],
		["update offer set status = 'open' where round = 3", "offer_status_moves"],
		[
			"update offer set status = 'superseded' where round = 3; update offer set status = 'accepted' where round = 3",
			"offer_status_moves",
		],
		[
			`${NEXT_ROUND}; update offer set status = 'superseded' where round = 4`,
			"offer_status_moves",
		],
	],
	"a round is superseded only when a later round of its deal is accepted": [
		[
			`update offer set status = 'superseded' where round = 3; ${CHECK_AT_COMMIT}`,
			"offer_superseded_by_later_acceptance",
		],
		[
			`update offer set status = 'superseded' where round = 3; ${NEXT_ROUND}; ${CHECK_AT_COMMIT}`,
			"offer_superseded_by_later_acceptance",
		],
		[
			`${offer(4, 3, AGENT, "listing_agent", { status: "superseded" })}; ${CHECK_AT_COMMIT}`,
			"offer_superseded_by_later_acceptance",
		],
	],
	"a social account is on a known platform, once per handle in any case": [
		[
			`insert into social_account (platform, owner_party_id, handle) values ('myspace', '${PARTNER}', 'example')`,
			"social_account_platform_check",
		],
		[
			`insert into social_account (platform, owner_party_id, handle) values ('x', '${PARTNER}', 'JordanExample')`,
			"social_account_one_per_handle",
		],
	],
	"a platform reports metrics from the known lists, each once": [
		[
			"insert into platform_metric values ('myspace', 'views')",
			"platform_metric_platform_check",
		],
		[
			"insert into platform_metric values ('x', 'likes')",
			"platform_metric_metric_check",
		],
		[
			"insert into platform_metric values ('x', 'views')",
			"platform_metric_pkey",
		],
	],
	"a post is scheduled, published or failed, and only a published post has its platform id and time":
		[
			[
				newPost({ platform: "linkedin" }),
				"post_social_account_id_platform_fkey",
			],
			[newPost({ status: "removed" }), "post_status_check"],
			[
				newPost({ status: "published", platform_post_id: "example-9" }),
				"post_published_has_id_and_time",
			],
			[
				newPost({ status: "published", published_at: "2026-06-09" }),
				"post_published_has_id_and_time",
			],
			[
				newPost({ status: "failed", platform_post_id: "example-9" }),
				"post_published_has_id_and_time",
			],
			[
				newPost({
					status: "published",
					platform_post_id: "example-4",
					published_at: "2026-06-09",
				}),
				"post_social_account_id_platform_post_id_key",
			],
		],
	"a post is never removed, and a published or failed post keeps its status": [
		["delete from post where status = 'failed'", "post_keeps_history"],
		["truncate post cascade", "measurement_keeps_history"],
		[
			"update post set status = 'scheduled' where status = 'failed'",
			"post_keeps_history",
		],
		[
			`update post set status = 'failed' where id = '${post(1)}'`,
			"post_keeps_history",
		],
	],
	"a reading is a metric its post's platform reports, never negative, and not measured is a reason, never a zero":
		[
			[newReading("1", "null", "saves"), "measurement_platform_metric_fkey"],
			[
				newReading("1", "null", "views", "x"),
				"measurement_post_id_platform_fkey",
			],
			[newReading("-1"), "measurement_value_check"],
			[newReading("null"), "measurement_value_or_reason"],
			[newReading("0", "'Example'"), "measurement_value_or_reason"],
		],
	"a reading is stored once and never rewritten or removed": [
		[
			`insert into measurement select * from measurement limit 1`,
			"measurement_pkey",
		],
		["update measurement set value = 1", "measurement_keeps_history"],
		["delete from measurement", "measurement_keeps_history"],
		["truncate measurement", "measurement_keeps_history"],
	],
};

// Each case runs in a transaction it rolls back, so a broken rule leaves nothing behind.
async function rolledBack(run: () => Promise<unknown>) {
	await db.query("begin");
	try {
		await run();
	} finally {
		await db.query("rollback");
	}
}
const readDeal = async () =>
	(await db.query("select everything_about_deal($1) as deal", [DEAL])).rows[0]
		.deal;

const url = process.env.TEST_DATABASE_URL;
if (!url)
	throw new Error("Run npm run check to restore the test database first");
// Its own database, because this schema's trigger would change the count database.test.ts reads.
const name = `engine_next_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url });
const target = new URL(url);
target.pathname = `/${name}`;
const connect = async () => {
	const client = new pg.Client({
		connectionString: target.href,
		options: "-c search_path=next -c TimeZone=UTC",
	});
	await client.connect();
	return client;
};
let db: pg.Client;

before(async () => {
	await admin.connect();
	await admin.query(`create database "${name}" template template0`);
	db = await connect();
	const schema = await readFile(
		new URL("../schema/next.sql", import.meta.url),
		"utf8",
	);
	await db.query(`create schema next; ${schema} ${SEED} ${MARKETING_SEED}`);
	for (const { documents, ...round } of rounds) {
		await db.query(
			"insert into offer select * from jsonb_populate_record(null::offer, $1)",
			[{ ...round, deal_id: DEAL, status: "open" }],
		);
		for (const document of documents)
			await db.query(
				`with saved as (insert into document
					select * from jsonb_populate_record(null::document, $1) returning id)
				insert into offer_document select $2, id from saved`,
				[document, round.id],
			);
		if (round.answers_round)
			await db.query("update offer set status = 'countered' where round = $1", [
				round.answers_round,
			]);
	}
	await db.query("update offer set status = 'accepted' where round = 3");
});

after(async () => {
	await db.end();
	await admin.query(`drop database "${name}" with (force)`);
	await admin.end();
});

test("everything about the LOI deal comes back in one read, each list in order", async () => {
	assert.deepEqual(await readDeal(), {
		deal: { id: DEAL, name: "Example Dental Springfield Deal" },
		phases,
		properties: [{ id: PROPERTY, address: "100 Example Way, Springfield" }],
		parties: [
			{
				id: CLIENT,
				kind: "company",
				name: "Example Dental Group",
				role: "client",
			},
			{
				id: AGENT,
				kind: "person",
				name: "Avery Example",
				role: "listing_agent",
			},
		],
		offers: rounds,
		activity: [
			{
				id: EMAIL,
				kind: "email",
				happened_at: "2026-03-09T14:00:00+00:00",
				from_party_id: AGENT,
				summary: null,
				email: {
					message_id: "<counter-2@example.com>",
					sender: "avery@example.com",
					subject: "Counter to your LOI",
					body: "Our counter is attached.",
					documents: [rounds[1]?.documents[0]],
				},
			},
			{
				id: CALL,
				kind: "call",
				happened_at: "2026-03-10T16:00:00+00:00",
				from_party_id: CLIENT,
				summary: "Example asks for a shorter term",
				email: null,
			},
		],
		next_steps: [
			{
				id: id(401),
				what: "Send the signed LOI",
				owner_party_id: CLIENT,
				due_on: "2026-03-13",
				done_at: "2026-03-13T18:00:00+00:00",
			},
			{
				id: id(400),
				what: "Start the lease draft",
				owner_party_id: null,
				due_on: "2026-03-20",
				done_at: null,
			},
		],
	});
});

for (const [rule, cases] of Object.entries(RULES))
	test(rule, async () => {
		for (const [sql, constraint] of cases)
			await rolledBack(() => assert.rejects(db.query(sql), { constraint }));
	});

test("a scheduled post can be published", () =>
	rolledBack(() =>
		db.query(
			`update post set status = 'published', platform_post_id = 'example-8', published_at = now() where id = $1`,
			[post(8)],
		),
	));

test("posts compare at day 7, best and worst per account", async () => {
	const ranked = (
		n: number,
		idea: string,
		template: string,
		rate: number,
		age = 168,
	) => ({
		id: post(n),
		published_at: `${POST_ROWS[n - 1]?.[4]}T15:00:00+00:00`,
		idea_id: idea,
		design_template_id: template,
		engagement_per_view: rate,
		reading_age_hours: age,
	});
	const account = (
		id: string,
		platform: string,
		handle: string,
		...posts: ReturnType<typeof ranked>[]
	) => ({
		id,
		platform,
		owner_party_id: PARTNER,
		handle,
		posts: posts.length,
		best: posts[0],
		worst: posts.at(-1),
	});
	const { rows } = await db.query("select posts_at_day_7($1) as read", [
		"2026-06-25T00:00:00+00:00",
	]);
	const checklistOnStatCard = ranked(4, CHECKLIST_IDEA, STAT_CARD, 0.04, 160);
	assert.deepEqual(rows[0].read, {
		accounts: [
			account(
				INSTAGRAM,
				"instagram",
				"jordan.example",
				ranked(9, CHECKLIST_IDEA, PHOTO, 0.09),
			),
			account(
				LINKEDIN,
				"linkedin",
				"jordan-example",
				ranked(2, CHECKLIST_IDEA, PHOTO, 0.07),
				ranked(1, RENT_IDEA, STAT_CARD, 0.05),
			),
			account(X, "x", "jordanexample", checklistOnStatCard),
		],
	});
});

test("day 7 is 168 hours after publishing, even across a clock change", () =>
	rolledBack(async () => {
		await db.query("set local time zone 'America/Chicago'");
		await db.query(
			`insert into post (id, social_account_id, platform, scheduled_at, status, platform_post_id, published_at)
			values ($1, $2, 'x', $3, 'published', 'example-clock', $3)`,
			[post(11), X, "2026-10-29T15:00:00+00:00"],
		);
		await db.query(
			`insert into measurement (post_id, platform, metric, taken_at, source, value)
			select $1, 'x', metric, $2, 'example_source', value
			from unnest(array['views', 'reactions', 'comments', 'shares'], array[100, 10, 0, 0]) as r (metric, value)`,
			[post(11), "2026-11-05T15:00:00+00:00"],
		);
		const { rows } = await db.query("select posts_at_day_7($1) as read", [
			"2026-11-05T15:00:00+00:00",
		]);
		const x = rows[0].read.accounts.find(
			(account: { platform: string }) => account.platform === "x",
		);
		assert.equal(x.best.id, post(11));
	}));

test("a deal that dies after acceptance keeps its accepted round, and a revival accepts a new one", () =>
	rolledBack(async () => {
		await db.query(
			`insert into deal_phase_change values
				($1, '2026-05-01T15:00:00+00:00', 'negotiation', 'Talks restarted'),
				($1, '2026-04-01T15:00:00+00:00', 'dead', 'Example financing fell through')`,
			[DEAL],
		);
		assert.equal((await readDeal()).offers[2].status, "accepted");
		await db.query("update offer set status = 'superseded' where round = 3");
		await db.query(NEXT_ROUND);
		await db.query("update offer set status = 'accepted' where round = 4");
		await db.query(CHECK_AT_COMMIT);
		const deal = await readDeal();
		assert.deepEqual(
			deal.offers.map(({ status }: { status: string }) => status),
			["countered", "countered", "superseded", "accepted"],
		);
		assert.deepEqual(
			deal.phases.map(({ phase }: { phase: string }) => phase),
			["negotiation", "legal", "dead", "negotiation"],
		);
	}));

test("two partners adding different lenders to one deal at once both keep them", async () => {
	const writers = [await connect(), await connect()];
	try {
		for (const writer of writers) await writer.query("begin");
		await writers[1]?.query("set local lock_timeout = '1s'");
		for (const [i, writer] of writers.entries())
			await writer.query("insert into deal_party values ($1, $2, 'lender')", [
				LENDER_DEAL,
				LENDERS[i],
			]);
		for (const writer of writers) await writer.query("commit");
		const { rows } = await db.query(
			"select party_id from deal_party where deal_id = $1 order by party_id",
			[LENDER_DEAL],
		);
		assert.deepEqual(
			rows.map((row) => row.party_id),
			LENDERS,
		);
	} finally {
		await Promise.all(writers.map((writer) => writer.end()));
	}
});
