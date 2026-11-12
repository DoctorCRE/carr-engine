import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { checkFields, hasToolCallMarkup } from "./answer.ts";
import worker from "./worker.ts";

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "gate-partner", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};

async function answered(path: string) {
	const response = await worker.request(
		`https://app.example.test/api/engine${path}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{
			CARR: signedIn,
			DATABASE: { connectionString: "postgres://made-up@127.0.0.1:1/none" },
		},
	);
	const { correlation_id: _, ...body } = (await response.json()) as Record<
		string,
		unknown
	>;
	return [response.status, body];
}

const markup = (fields: string[]) => [
	400,
	{
		error: "tool_call_markup_in_value",
		hint: "Remove tool-call markup from the named fields.",
		fields,
	},
];
const number = (field: string) => [
	400,
	{
		error: "invalid_number",
		hint: "Supply a numeric value for the named fields.",
		fields: [field],
	},
];
const vocabulary = (allowed: string[]) => [
	400,
	{
		error: "value_not_in_declared_vocabulary",
		hint: "Use a value from the field's documented vocabulary.",
		allowed_values: allowed,
		fields: ["workspace"],
	},
];
const generic = (status: number) => [
	status,
	{
		error: "unhandled_verb_failure",
		hint: "The operation failed. Quote the correlation_id when reporting it.",
	},
];
const read = (verb: string) => [
	500,
	{
		error: "unhandled_verb_failure",
		hint: "The operation failed. Quote the correlation_id when reporting it.",
		verb,
	},
];
const json = (value: unknown) => encodeURIComponent(JSON.stringify(value));

test("every read refuses tool-call markup and repeated fields as the old gate did", async () => {
	const warnings = mock.method(console, "warn", () => {});
	try {
		for (const [path, expected] of [
			[
				"/deals?account_client_id=x%3C%2Faccount_client_id%3E",
				markup(["account_client_id"]),
			],
			[
				"/deals?workspace=bogus&account_client_id=%3C%2Faccount_client_id%3E",
				vocabulary(["team", "national_account", "all"]),
			],
			[
				"/deals?workspace=team&workspace=team",
				vocabulary(["team", "national_account", "all"]),
			],
			["/deals/x%3C%2Fdeal%3E", markup(["deal"])],
			["/deals/Example?deal=x%3C%2Fdeal%3E", read("get-deal-room")],
			[
				"/client-fit?state=a%20%3Cparameter%20name%3D%22x%22%3E",
				markup(["state"]),
			],
			["/find?query=a%20%3C%2Finvoke%3E", markup(["query"])],
			["/find?query=quoted%20%60%3Cinvoke%3E%60%20prose", read("find")],
			["/recent-activity?query=Example&limit=5&limit=5", number("limit")],
			["/recent-activity?query=Example&query=Example", generic(422)],
			[
				"/leads?stage_history_cursor=%3C%2Fstage_history_cursor%3E",
				markup(["stage_history_cursor"]),
			],
			[`/leads?correspondence_cursor=${json({ id: "x</id>" })}`, markup([])],
			[
				`/leads?correspondence_cursor=${json({ id: "</correspondence_cursor>" })}`,
				generic(400),
			],
			["/leads?workspace=leads&workspace=leads", vocabulary(["leads"])],
			[
				"/quiet-follow-ups?owner_slug=%3C%2Fowner_slug%3E",
				markup(["owner_slug"]),
			],
			[
				"/quiet-follow-ups?lead_days=x&owner_slug=%3C%2Fowner_slug%3E",
				number("lead_days"),
			],
			["/quiet-follow-ups?lead_days=5&lead_days=5", number("lead_days")],
			["/quiet-follow-ups?owner_slug=a&owner_slug=a", generic(422)],
			[
				"/reasons-to-reach-out?before_id=%3C%2Fbefore_id%3E",
				markup(["before_id"]),
			],
			["/reasons-to-reach-out?before_id=9&before_id=9", generic(400)],
			["/territory-state-board?city=%3C%2Fcity%3E", markup(["city"])],
			[
				"/territory-state-board?city=%3C%2Fcity%3E&city=Springfield",
				read("territory-state-board"),
			],
			["/vendor-markets?market=%60a%0A%3Cinvoke%60", markup(["market"])],
		] as const)
			assert.deepEqual(await answered(path), expected, path);
	} finally {
		warnings.mock.restore();
	}
});

// Expected answers are the old looksLikeToolCallMarkup's on the same input.
test("a close_ field's own closing tag drops the prefix once, as the old door's did", () => {
	for (const [field, value, refused] of [
		["close_outcome", "</outcome>", true],
		["close_outcome", "done </outcome> next", true],
		["close_outcome", "</close_outcome>", false],
		["close_", "</>", true],
		["close_", "</close_>", false],
		["close_close_x", "</close_x>", true],
		["close_close_x", "</x>", false],
		["close_close_x", "</close_close_x>", false],
		["CLOSE_outcome", "</outcome>", false],
		["CLOSE_outcome", "</CLOSE_outcome>", true],
		["Close_outcome", "</outcome>", false],
		["note_close_x", "</x>", false],
		["note_close_x", "</note_close_x>", true],
		["close_outcome", "", false],
		["close_outcome", "`<parameter` quoted", false],
		["close_outcome", "<parameter name", true],
	] as const)
		assert.equal(hasToolCallMarkup(field, value), refused, `${field} ${value}`);

	const marked = (field: string, value: string) =>
		checkFields(new URLSearchParams({ [field]: value }), [field], {
			objects: { filter: ["close_outcome"] },
		})?.extra.fields;
	assert.deepEqual(marked("close_outcome", "</outcome>"), ["close_outcome"]);
	assert.deepEqual(
		marked("filter", JSON.stringify({ close_outcome: "</outcome>" })),
		[],
	);
});
