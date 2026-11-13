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
const PHOTO_FILE = id(540);
// Review closes an hour before a post's time, judged by the real clock.
const OPEN = post(13);
const CLOSED = post(14);
const ENGINE_FROM = "2026-06-08T05:00:00+00:00";
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
insert into social_account (id, platform, owner_party_id, handle, platform_account_id) values
	('${LINKEDIN}', 'linkedin', '${PARTNER}', 'jordan-example', 'example-person-1'),
	('${X}', 'x', '${PARTNER}', 'jordanexample', null), ('${INSTAGRAM}', 'instagram', '${PARTNER}', 'jordan.example', null);
-- Only the owner sets when the engine starts publishing for an account.
set role none;
update social_account set engine_publishes_from = '${ENGINE_FROM}' where id = '${LINKEDIN}';
set role engine;
insert into social_sign_in values ('${LINKEDIN}', 'example-person-1', '${PARTNER}',
	'2026-06-01T15:00:00+00:00', '2026-07-31T15:00:00+00:00', '{openid,profile,w_member_social}');
insert into idea (id, angle, hook, pillar) values
	('${RENT_IDEA}', 'Example rents rose this year', 'number', 'local_market'),
	('${CHECKLIST_IDEA}', 'Five example lease questions', 'checklist', 'education');
insert into design_template (id, name) values ('${STAT_CARD}', 'Example stat card'), ('${PHOTO}', 'Example photo backdrop');
insert into post (id, social_account_id, platform, format, idea_id, design_template_id, scheduled_at, status, reason,
	platform_post_id, published_at)
values ${POST_ROWS.map(
	([n, account, idea, template, day, status]) =>
		`('${post(n)}', '${account}', (select platform from social_account where id = '${account}'),
		'${template ? "photo" : "text"}', '${idea}', ${template && `'${template}'`}, '${day}T15:00:00+00:00', '${status}',
		${status === "failed" ? "'Example: the platform refused it'" : "null"}, ${
			status === "published"
				? `'example-${n}', '${day}T15:00:00+00:00'`
				: "null, null"
		})`,
)};
insert into document (id, name, r2_key) values ('${PHOTO_FILE}', 'Example photo.jpg', 'example/photo.jpg');
insert into post_media (post_id, format, position, document_id) values ('${post(8)}', 'photo', 1, '${PHOTO_FILE}');
insert into post (id, social_account_id, platform, format, scheduled_at) values
	('${OPEN}', '${LINKEDIN}', 'linkedin', 'photo', now() + interval '2 hours'),
	('${CLOSED}', '${LINKEDIN}', 'linkedin', 'photo', now() + interval '30 minutes');
insert into post_text (post_id, version, body) values ('${OPEN}', 1, 'Five example lease questions');
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
const insert = (table: string, row: Record<string, string | number | null>) =>
	`insert into ${table} (${Object.keys(row)}) values (${Object.values(row).map(
		(value) => (value === null ? "null" : `'${value}'`),
	)})`;
const newPost = (row: Record<string, string>) =>
	insert("post", {
		social_account_id: LINKEDIN,
		platform: "linkedin",
		format: "photo",
		scheduled_at: "2026-06-09",
		...row,
	});
const PUBLISHED = {
	status: "published",
	platform_post_id: "example-new",
	published_at: "2026-06-09",
};
const newReading = (row: Record<string, string | number | null>) =>
	insert("measurement", {
		post_id: post(1),
		platform: "linkedin",
		metric: "views",
		taken_at: "2026-06-20T15:00:00+00:00",
		source: "example_source",
		value: 1,
		not_measured_reason: null,
		...row,
	});
const NEW_ACCOUNT = `insert into social_account (id, platform, owner_party_id, handle)
	values ('${id(503)}', 'facebook', '${PARTNER}', 'example-page')`;
const CLAIM = `update post set status = 'publishing' where id = '${post(8)}'`;
const newText = (row: Record<string, string | number | null>) =>
	insert("post_text", {
		post_id: OPEN,
		version: 2,
		body: "Six example lease questions",
		author_party_id: PARTNER,
		...row,
	});
const newMedium = (row: Record<string, string | number>) =>
	insert("post_media", {
		post_id: post(8),
		format: "photo",
		position: 1,
		document_id: PHOTO_FILE,
		...row,
	});
const newReview = (row: Record<string, string | number | null>) =>
	insert("post_review", { post_id: OPEN, by_party_id: PARTNER, ...row });
const EDITED = `${newText({})}; ${newReview({ outcome: "edited", text_version: 2 })}`;
const NO_RESPONSE = {
	post_id: CLOSED,
	outcome: "no_response",
	by_party_id: null,
};
const cancel = (post: string) =>
	`update post set status = 'cancelled', reason = 'Example: the rent number changed' where id = '${post}'`;
const newSignIn = (row: Record<string, string>) =>
	insert("social_sign_in", {
		social_account_id: LINKEDIN,
		platform_account_id: "example-person-1",
		signed_in_by_party_id: PARTNER,
		signed_in_at: "2026-07-30T15:00:00+00:00",
		expires_at: "2026-09-28T15:00:00+00:00",
		scopes: "{w_member_social}",
		...row,
	});
const NOT_MEASURED = {
	value: null,
	not_measured_reason: "Example: no number came back",
};
const DAY_7 = "2026-06-25T00:00:00+00:00";
// Per account: how many posts compared, then the best and the worst.
const compared = async (client = db) =>
	(
		await client.query("select posts_at_day_7($1) as read", [DAY_7])
	).rows[0].read.accounts.map(
		(account: {
			platform: string;
			posts: number;
			best: { id: string };
			worst: { id: string };
		}) => [account.platform, account.posts, account.best.id, account.worst.id],
	);

// The engine's role lacks the privilege, so PostgreSQL refuses before any row is touched.
const notGranted = (table: string) => ({
	code: "42501",
	message: `permission denied for table ${table}`,
});
const STAMPED = [
	"party",
	"property",
	"deal",
	"party_role",
	"party_company",
	"deal_property",
	"deal_party",
	"activity_about",
	"offer_document",
	"next_step",
	"document",
	"social_account",
	"idea",
	"design_template",
	"post_media",
];

// A constraint's name, or the error PostgreSQL raises.
type Refusal = string | { code?: string; message: string };
const expected = (refusal: Refusal) =>
	typeof refusal === "string" ? { constraint: refusal } : refusal;

const SCHEMA = await readFile(
	new URL("../schema/next.sql", import.meta.url),
	"utf8",
);

const RULES: Record<string, [sql: string, refusal: Refusal][]> = {
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
				notGranted("deal_phase_change"),
			],
			["delete from deal_phase_change", notGranted("deal_phase_change")],
			["truncate deal_phase_change", notGranted("deal_phase_change")],
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
			["truncate activity_about", notGranted("activity_about")],
			[
				`update activity_about set activity_id = '${CALL}' where activity_id = '${EMAIL}'`,
				notGranted("activity_about"),
			],
			[`update email set activity_id = '${CALL}'`, notGranted("email")],
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
			notGranted("offer"),
		],
		["delete from offer where round = 3", notGranted("offer")],
		["truncate offer cascade", notGranted("offer")],
		[
			`delete from offer_document where document_id = '${id(200)}'`,
			notGranted("offer_document"),
		],
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
		[
			`insert into social_account (platform, owner_party_id, handle) values ('x', '${PARTNER}', '\t')`,
			"social_account_handle_check",
		],
	],
	"a social account's platform id is never blank, used once per platform, and fixed once someone signed in as it":
		[
			[
				`insert into social_account (platform, owner_party_id, handle, platform_account_id)
				values ('linkedin', '${PARTNER}', 'another-example', 'example-person-1')`,
				"social_account_platform_platform_account_id_key",
			],
			[
				`update social_account set platform_account_id = ' ' where id = '${X}'`,
				"social_account_platform_account_id_check",
			],
			[
				`update social_account set platform_account_id = 'example-person-2' where id = '${LINKEDIN}'`,
				"social_sign_in_social_account_id_platform_account_id_fkey",
			],
		],
	"a sign-in is as its account's own platform id, expires after it starts, and is never rewritten or removed":
		[
			[
				newSignIn({ platform_account_id: "example-person-2" }),
				"social_sign_in_social_account_id_platform_account_id_fkey",
			],
			[
				newSignIn({ expires_at: "2026-07-30T15:00:00+00:00" }),
				"social_sign_in_check",
			],
			[
				"update social_sign_in set expires_at = null",
				notGranted("social_sign_in"),
			],
			["delete from social_sign_in", notGranted("social_sign_in")],
		],
	"only the schema adds a platform's metrics or formats": [
		[
			"insert into platform_metric values ('x', 'saves')",
			notGranted("platform_metric"),
		],
		[
			"insert into platform_format values ('x', 'document')",
			notGranted("platform_format"),
		],
	],
	"a post's format is one its platform offers": [
		[newPost({ format: "reel" }), "post_platform_format_fkey"],
		[
			newPost({
				...PUBLISHED,
				social_account_id: INSTAGRAM,
				platform: "instagram",
				format: "document",
			}),
			"post_platform_format_fkey",
		],
	],
	"a post's status is known, only a published post has its platform id and time, and a failed or cancelled one says why":
		[
			[newPost({ platform: "x" }), "post_social_account_id_platform_fkey"],
			[newPost({ status: "removed" }), "post_status_check"],
			[newPost({ status: "publishing" }), "post_status_moves"],
			[
				newPost({ status: "cancelled", reason: "Example" }),
				"post_status_moves",
			],
			[newPost({ status: "failed" }), "post_failed_or_cancelled_says_why"],
			[newPost({ reason: "Example" }), "post_failed_or_cancelled_says_why"],
			[newPost({ status: "failed", reason: " " }), "post_reason_check"],
			[
				newPost({ status: "published", platform_post_id: "example-9" }),
				"post_published_has_id_and_time",
			],
			[
				newPost({ status: "published", published_at: "2026-06-09" }),
				"post_published_has_id_and_time",
			],
			[
				newPost({
					status: "failed",
					reason: "Example",
					platform_post_id: "example-9",
				}),
				"post_published_has_id_and_time",
			],
			[
				newPost({ ...PUBLISHED, platform_post_id: "example-1" }),
				"post_social_account_id_platform_post_id_key",
			],
		],
	"a post moves from scheduled to publishing or cancelled, and from publishing to published or failed":
		[
			[
				`update post set status = 'published', platform_post_id = 'example-8', published_at = now()
				where id = '${post(8)}'`,
				"post_status_moves",
			],
			[
				`update post set status = 'failed', reason = 'Example' where id = '${post(8)}'`,
				"post_status_moves",
			],
			[
				`${CLAIM}; update post set status = 'scheduled' where id = '${post(8)}'`,
				"post_status_moves",
			],
			[
				`${CLAIM}; update post set status = 'cancelled', reason = 'Example' where id = '${post(8)}'`,
				"post_status_moves",
			],
		],
	"the engine holds only posts scheduled from its account's engine_publishes_from, and none means never":
		[
			[
				`insert into social_account (platform, owner_party_id, handle, engine_publishes_from)
				values ('facebook', '${PARTNER}', 'example-page', now())`,
				notGranted("social_account"),
			],
			[
				`${NEW_ACCOUNT}; delete from social_account where id = '${id(503)}'; ${NEW_ACCOUNT};
				${newPost({ social_account_id: id(503), platform: "facebook" })}`,
				"post_engine_publishes_from",
			],
			[
				newPost({ scheduled_at: "2026-06-08T04:59:59+00:00" }),
				"post_engine_publishes_from",
			],
			[
				newPost({ social_account_id: X, platform: "x" }),
				"post_engine_publishes_from",
			],
		],
	"a post is never removed, and published, failed or cancelled is final": [
		["delete from post where status = 'failed'", notGranted("post")],
		["truncate post cascade", notGranted("post")],
		[
			"update post set reason = 'Another example' where status = 'failed'",
			"post_final",
		],
		[
			`update post set status = 'cancelled', reason = 'Example' where id = '${post(8)}';
		update post set reason = 'Another example' where id = '${post(8)}'`,
			"post_final",
		],
		[`update post set status = 'failed' where id = '${post(1)}'`, "post_final"],
		[
			`update post set published_at = published_at - interval '1 day' where id = '${post(1)}'`,
			"post_final",
		],
		[
			`update post set platform_post_id = 'example-99' where id = '${post(1)}'`,
			"post_final",
		],
	],
	"a post's text is edited as the next version by a partner, while it is scheduled and until review closes":
		[
			[newText({ version: 1 }), "post_text_pkey"],
			[newText({ version: 0 }), "post_text_version_check"],
			[newText({ version: 3 }), "post_text_post_id_previous_version_fkey"],
			[newText({ body: " \n" }), "post_text_body_check"],
			[newText({ author_party_id: null }), "post_text_edit_has_author"],
			[newText({ post_id: CLOSED }), "post_text_before_review_closes"],
			[`${cancel(OPEN)}; ${newText({})}`, "post_text_before_review_closes"],
			[newText({ written_at: "2020-01-01" }), notGranted("post_text")],
			["update post_text set body = 'Example'", notGranted("post_text")],
			["delete from post_text", notGranted("post_text")],
		],
	"a post's media fit its format, in order, and never change": [
		[newMedium({ post_id: post(5), format: "text" }), "post_media_fits_format"],
		[newMedium({ position: 2 }), "post_media_fits_format"],
		[
			`${newPost({ id: post(12), format: "photo_set" })};
			${newMedium({ post_id: post(12), format: "photo_set", position: 21 })}`,
			"post_media_position_check",
		],
		[
			newMedium({ post_id: post(1), format: "video" }),
			"post_media_post_id_format_fkey",
		],
		[newMedium({}), "post_media_pkey"],
		["update post_media set position = 2", notGranted("post_media")],
		["delete from post_media", notGranted("post_media")],
	],
	"a review is a partner's edit or cancel before review closes, or no response alone at its close, each once":
		[
			[newReview({ outcome: "approved" }), "post_review_outcome_check"],
			[newReview({ outcome: "edited" }), "post_review_edit_names_its_text"],
			[
				newReview({ outcome: "edited", text_version: 1 }),
				"post_review_text_version_check",
			],
			[
				newReview({ outcome: "edited", text_version: 5 }),
				"post_review_post_id_text_version_fkey",
			],
			[
				newReview({ ...NO_RESPONSE, by_party_id: PARTNER }),
				"post_review_by_a_partner",
			],
			[
				`${cancel(CLOSED)}; ${newReview({ post_id: CLOSED, outcome: "cancelled" })}`,
				"post_review_in_window",
			],
			[newReview({ ...NO_RESPONSE, post_id: OPEN }), "post_review_in_window"],
			[newReview({ outcome: "cancelled" }), "post_review_matches_the_post"],
			[
				`${cancel(CLOSED)}; ${newReview(NO_RESPONSE)}`,
				"post_review_matches_the_post",
			],
			[
				`${newReview(NO_RESPONSE)}; ${newReview(NO_RESPONSE)}`,
				"post_review_once",
			],
			[
				newReview({ outcome: "cancelled", reviewed_at: "2020-01-01" }),
				notGranted("post_review"),
			],
			[
				`${EDITED}; update post_review set by_party_id = null`,
				notGranted("post_review"),
			],
			[`${EDITED}; delete from post_review`, notGranted("post_review")],
		],
	"a reading is a metric its post's platform reports, names its source, is never negative, and not measured is a reason, never a zero":
		[
			[newReading({ metric: "saves" }), "measurement_platform_metric_fkey"],
			[newReading({ platform: "x" }), "measurement_post_id_platform_fkey"],
			[newReading({ value: -1 }), "measurement_value_check"],
			[newReading({ value: null }), "measurement_value_or_reason"],
			[
				newReading({ value: 0, not_measured_reason: "Example" }),
				"measurement_value_or_reason",
			],
			[newReading({ source: "\n" }), "measurement_source_check"],
			[
				newReading({ ...NOT_MEASURED, not_measured_reason: " \t\n" }),
				"measurement_not_measured_reason_check",
			],
		],
	"a reading is of a published post, taken no earlier than it was published": [
		[newReading({ post_id: post(8) }), "measurement_after_publishing"],
		[
			newReading({ post_id: post(7), platform: "x" }),
			"measurement_after_publishing",
		],
		[
			newReading({ taken_at: "2026-06-01T14:59:59+00:00" }),
			"measurement_after_publishing",
		],
	],
	"a reading is stored once and never rewritten or removed": [
		[
			`insert into measurement select * from measurement limit 1`,
			"measurement_pkey",
		],
		["update measurement set value = 1", notGranted("measurement")],
		["delete from measurement", notGranted("measurement")],
		["truncate measurement", notGranted("measurement")],
	],
	"a record or link keeps when it was stored": STAMPED.map((table) => [
		`update ${table} set created_at = now()`,
		notGranted(table),
	]),
};
const RELOAD = `create schema again; set local search_path = again; ${SCHEMA}`;
const TOO_MUCH = { message: "role engine holds rights beyond its grants" };
// Rules on paths only the schema's owner can take.
const OWNER_RULES: Record<string, [sql: string, refusal: Refusal][]> = {
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
	"no response is a post's only review, even when its time moves": [
		[
			`${EDITED}; update post set scheduled_at = now() + interval '30 minutes' where id = '${OPEN}';
			set local role engine; ${newReview({ ...NO_RESPONSE, post_id: OPEN })}`,
			"post_review_in_window",
		],
		[
			`${newReview(NO_RESPONSE)}; update post set scheduled_at = now() + interval '2 hours' where id = '${CLOSED}';
			set local role engine; ${cancel(CLOSED)}; ${newReview({ post_id: CLOSED, outcome: "cancelled" })}`,
			"post_review_in_window",
		],
	],
	"the engine claims no post once its account's engine_publishes_from moves past it":
		[
			[
				`update social_account set engine_publishes_from = '2026-07-01' where id = '${LINKEDIN}';
			set local role engine; ${CLAIM}`,
				"post_engine_publishes_from",
			],
		],
	"a platform offers formats from the known lists, each once": [
		[
			"insert into platform_format values ('myspace', 'text')",
			"platform_format_platform_check",
		],
		[
			"insert into platform_format values ('x', 'reel')",
			"platform_format_format_check",
		],
		[
			"insert into platform_format values ('x', 'text')",
			"platform_format_pkey",
		],
	],
	"loading the schema refuses an engine role with rights beyond its grants": [
		[`grant pg_write_all_data to engine; ${RELOAD}`, TOO_MUCH],
		[`alter role engine bypassrls; ${RELOAD}`, TOO_MUCH],
	],
};
// What the engine may change; every other column, and every row of history, stays as stored.
const CHANGEABLE: Record<string, string[]> = {
	role: ["label"],
	phase: ["label"],
	party: ["name"],
	property: ["address"],
	deal: ["name"],
	party_company: ["ended_on", "started_on", "title"],
	activity: ["from_party_id", "happened_at", "summary"],
	next_step: ["done_at", "due_on", "owner_party_id", "what"],
	document: ["name"],
	offer: ["status"],
	social_account: ["handle", "platform_account_id"],
	idea: ["angle", "hook", "pillar"],
	design_template: ["name"],
	post: ["platform_post_id", "published_at", "reason", "status"],
};
// Columns the engine leaves to their default when it adds a row.
const DEFAULTED: Record<string, string[]> = {
	social_account: ["engine_publishes_from"],
	post_text: ["previous_version", "written_at"],
	post_review: ["reviewed_at"],
};
const REMOVABLE = [
	...STAMPED.filter(
		(table) => !["offer_document", "post_media"].includes(table),
	),
	"activity",
	"email",
];

// Each case runs in a transaction it rolls back, so a broken rule leaves nothing behind.
async function rolledBack(run: () => Promise<unknown>) {
	await db.query("begin");
	try {
		await run();
	} finally {
		await db.query("rollback");
	}
}
// Each case runs in its own owner's transaction, rolled back.
async function asOwner(cases: [sql: string, refusal: Refusal][]) {
	const owner = await connect("none");
	try {
		for (const [sql, refusal] of cases) {
			await owner.query("begin");
			try {
				await assert.rejects(owner.query(sql), expected(refusal));
			} finally {
				await owner.query("rollback");
			}
		}
	} finally {
		await owner.end();
	}
}
// When a row was stored is the clock's, so reads are compared without it.
const unstamped = (read: unknown) =>
	JSON.parse(
		JSON.stringify(read, (key, value) =>
			key === "created_at" ? undefined : value,
		),
	);
const readDeal = async () =>
	unstamped(
		(await db.query("select everything_about_deal($1) as deal", [DEAL])).rows[0]
			.deal,
	);

const url = process.env.TEST_DATABASE_URL;
if (!url)
	throw new Error("Run npm run check to restore the test database first");
// Its own database, because this schema's trigger would change the count database.test.ts reads.
const name = `engine_next_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url });
const target = new URL(url);
target.pathname = `/${name}`;
// Every test works as the engine; only loading the schema needs its owner (role none).
const connect = async (role = "engine") => {
	const client = new pg.Client({
		connectionString: target.href,
		options: `-c search_path=next -c TimeZone=UTC -c role=${role}`,
	});
	await client.connect();
	return client;
};
let db: pg.Client;

before(async () => {
	await admin.connect();
	await admin.query(`create database "${name}" template template0`);
	db = await connect("none");
	await db.query(`create schema next; ${SCHEMA}`);
	await db.query(`set role engine; ${SEED} ${MARKETING_SEED}`);
	for (const { documents, ...round } of rounds) {
		await db.query(
			"insert into offer select * from jsonb_populate_record(null::offer, $1)",
			[{ ...round, deal_id: DEAL, status: "open" }],
		);
		for (const document of documents)
			await db.query(
				`with saved as (insert into document (id, name, r2_key, email_activity_id)
					select id, name, r2_key, email_activity_id
					from jsonb_populate_record(null::document, $1) returning id)
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
		for (const [sql, refusal] of cases)
			await rolledBack(() => assert.rejects(db.query(sql), expected(refusal)));
	});

for (const [rule, cases] of Object.entries(OWNER_RULES))
	test(rule, () => asOwner(cases));

test("the engine adds, changes and removes only what its grants name, and empties no table", async () => {
	const { rows } = await db.query(
		`select c.relname as table,
			array_agg(a.attname::text order by a.attname)
				filter (where has_column_privilege(c.oid, a.attnum, 'update')) as changeable,
			has_any_column_privilege(c.oid, 'insert') as addable,
			array_agg(a.attname::text order by a.attname) filter (where has_any_column_privilege(c.oid, 'insert')
				and not has_column_privilege(c.oid, a.attnum, 'insert')) as defaulted,
			has_table_privilege(c.oid, 'delete') as removable,
			has_table_privilege(c.oid, 'truncate') as emptied
		from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
		where c.relnamespace = 'next'::regnamespace and c.relkind = 'r'
		group by c.oid order by c.relname`,
	);
	assert.deepEqual(
		rows,
		rows.map(({ table }) => ({
			table,
			changeable: CHANGEABLE[table] ?? null,
			addable: !["platform_metric", "platform_format"].includes(table),
			defaulted: DEFAULTED[table] ?? null,
			removable: REMOVABLE.includes(table),
			emptied: false,
		})),
	);
});

test("the engine claims a scheduled post, then publishes it", () =>
	rolledBack(() =>
		db.query(`${CLAIM}; update post set status = 'published', platform_post_id = 'example-8',
			published_at = now() where id = '${post(8)}'`),
	));

test("a partner's edit and cancel are reviewed before review closes, and an untouched post gets no response", () =>
	rolledBack(() =>
		db.query(`${EDITED}; ${cancel(OPEN)}; ${newReview({ outcome: "cancelled" })};
			${newReview(NO_RESPONSE)}`),
	));

test("a review holds its post until it is saved", async () => {
	const [partner, job] = [await connect(), await connect()];
	try {
		await partner.query(`begin; ${EDITED}`);
		await job.query("begin; set local lock_timeout = '100ms'");
		await assert.rejects(
			job.query("select from post where id = $1 for no key update", [OPEN]),
			{ code: "55P03" },
		);
	} finally {
		for (const client of [partner, job]) {
			await client.query("rollback");
			await client.end();
		}
	}
});

test("an account's engine_publishes_from waits while the engine claims one of its posts", async () => {
	const [engine, owner] = [await connect(), await connect("none")];
	try {
		await engine.query(`begin; ${CLAIM}`);
		await owner.query("begin; set local lock_timeout = '100ms'");
		await assert.rejects(
			owner.query(
				"update social_account set engine_publishes_from = null where id = $1",
				[LINKEDIN],
			),
			{ code: "55P03" },
		);
	} finally {
		for (const client of [engine, owner]) {
			await client.query("rollback");
			await client.end();
		}
	}
});

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
		platform_account_id: id === LINKEDIN ? "example-person-1" : null,
		engine_publishes_from: id === LINKEDIN ? ENGINE_FROM : null,
		posts: posts.length,
		best: posts[0],
		worst: posts.at(-1),
	});
	const { rows } = await db.query("select posts_at_day_7($1) as read", [DAY_7]);
	const checklistOnStatCard = ranked(4, CHECKLIST_IDEA, STAT_CARD, 0.04, 160);
	assert.deepEqual(unstamped(rows[0].read), {
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

test("at one instant, a measured reading wins over one that was not measured", () =>
	rolledBack(async () => {
		await db.query(
			newReading({
				...NOT_MEASURED,
				post_id: post(2),
				taken_at: "2026-06-10T15:00:00+00:00",
				source: "another_source",
			}),
		);
		assert.deepEqual((await compared())[1], ["linkedin", 2, post(2), post(1)]);
	}));

test("a metric added later is asked only of posts published since", async () => {
	const owner = await connect("none");
	try {
		await owner.query("begin");
		await owner.query(`insert into platform_metric (platform, metric) values ('x', 'saves');
			insert into platform_metric values ('linkedin', 'saves', '2026-06-02T00:00:00+00:00')`);
		assert.deepEqual(await compared(owner), [
			["instagram", 1, post(9), post(9)],
			["linkedin", 1, post(1), post(1)],
			["x", 1, post(4), post(4)],
		]);
	} finally {
		await owner.query("rollback");
		await owner.end();
	}
});

test("day 7 is 168 hours after publishing, even across a clock change", () =>
	rolledBack(async () => {
		await db.query("set local time zone 'America/Chicago'");
		await db.query(
			`insert into post (id, social_account_id, platform, format, scheduled_at, status, platform_post_id, published_at)
			values ($1, $2, 'x', 'text', $3, 'published', 'example-clock', $3)`,
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
