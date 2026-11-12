// A recorded research finding about a lead's party, as `to_jsonb` printed it.
export type Finding = {
	flag_id: string;
	kind: string;
	found: boolean;
	expired: boolean;
	proposes_correction: boolean;
	source: string;
	observed_at: string;
	expires_on: string | null;
	value: unknown;
};

type ContactActivity = {
	id: string;
	lead_id: string;
	kind: string;
	connected: boolean | null;
	occurred_at: string;
	source: string;
	detail: string | null;
};

// The party's routes and its recent captured activity, as `jsonb` printed them.
export type ContactInputs = {
	party_id: string;
	created_at: string;
	email: string | null;
	cell: null;
	phone: string | null;
	activities: ContactActivity[];
};

type Lead = { base_version: number; contact_eligible: boolean };

export const EVIDENCE_LIMIT = 500;
const FRESHNESS_DAYS = 90;
const DAY_MS = 86_400_000;
const CONNECTED_KINDS = new Set([
	"call",
	"text",
	"email_in",
	"meeting",
	"tour",
]);
const MAIL_SOURCES = new Set(["mail_ingest", "local_mail"]);
const ROUTE_KEYS = new Map<string, "phone" | "email" | "cell">([
	["office_phone", "phone"],
	["email", "email"],
	["cell", "cell"],
]);
const chicagoDay = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Chicago",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

// The old check counted a time with sub-millisecond digits from the next
// millisecond. Infinite and out-of-range times parse to NaN and never count.
const isCurrent = (f: Finding, now: number) =>
	!f.expired &&
	Date.parse(f.observed_at) + (/\.\d{3}\d*[1-9]/.test(f.observed_at) ? 1 : 0) <=
		now;

function researchState(current: Finding[]) {
	if (
		current.some(
			(f) => f.found && (f.kind === "discrepancy" || f.proposes_correction),
		)
	)
		return "needs_review";
	return current.some(
		(f) => f.kind === "verified" && f.found && f.source.trim() !== "",
	)
		? "verified"
		: "needs_research";
}

function parsedDetail(text: string | null): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

// Mail is a contact only when intake bound it to this party by hand-checked
// evidence; any other source must be a connected conversation.
function isSuccessfulContact(
	a: ContactActivity,
	input: ContactInputs,
	now: number,
) {
	const at = Date.parse(a.occurred_at);
	if (
		a.source.trim() === "" ||
		!(at <= now) ||
		at < now - FRESHNESS_DAYS * DAY_MS ||
		at < Date.parse(input.created_at)
	)
		return false;
	const detail = parsedDetail(a.detail);
	if (detail.party_id !== undefined && detail.party_id !== input.party_id)
		return false;
	if (MAIL_SOURCES.has(a.source))
		return (
			a.kind === "email_in" &&
			detail.match === "exact" &&
			detail.party_id === input.party_id &&
			typeof detail.evidence_ref === "string" &&
			detail.evidence_ref.trim() !== "" &&
			detail.automated === false
		);
	return a.connected === true && CONNECTED_KINDS.has(a.kind);
}

function isUsableRoute(f: Finding, input: ContactInputs, today: string) {
	const key = ROUTE_KEYS.get(f.kind);
	if (!key) return false;
	const route = input[key];
	const expires = f.expires_on ?? "";
	if (
		!route?.trim() ||
		!f.found ||
		f.source.trim() === "" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(expires) ||
		expires < today ||
		(key === "email"
			? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(route)
			: route.replace(/\D/g, "").length < 7)
	)
		return false;
	const { value } = f;
	return (
		typeof value === "object" &&
		value !== null &&
		key in value &&
		(value as Record<string, unknown>)[key] === route
	);
}

const sha256 = async (text: string) =>
	Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");

// The Reachable or Research label, `lead-reachability.v2`.
export async function reachability(
	lead: Lead,
	evidence: Finding[],
	input: ContactInputs,
	now: number,
) {
	const current = evidence.filter((f) => isCurrent(f, now));
	const research_state = researchState(current);
	const evidence_state =
		research_state === "needs_review"
			? "conflicting"
			: current.length > 0
				? "current"
				: evidence.some((f) => f.expired)
					? "expired"
					: "unknown";
	const today = chicagoDay.format(now);
	const contact = input.activities.find((a) =>
		isSuccessfulContact(a, input, now),
	);
	const route = current.find((f) => isUsableRoute(f, input, today));
	const missing_reasons = [
		...(lead.contact_eligible ? [] : ["contact_restricted"]),
		...(evidence_state === "conflicting" ? ["conflicting_evidence"] : []),
		...(evidence_state === "expired" ? ["expired_evidence"] : []),
		...(route ? [] : ["verified_usable_route_not_established"]),
		...(contact ? [] : ["recent_successful_contact_not_established"]),
	];
	// The fingerprint hashes JSON text, so key order and timestamp text must
	// stay exactly as `jsonb` printed them.
	const revision = JSON.stringify([
		lead.base_version,
		lead.contact_eligible,
		evidence,
		input,
	]);
	return {
		schema_version: "lead-reachability.v2",
		classification: missing_reasons.length > 0 ? "research" : "reachable",
		basis: "successful_contact_and_current_route",
		evidence_state,
		contact_eligible: lead.contact_eligible,
		research_state,
		missing_reasons,
		source_revision: `sha256:${await sha256(revision)}`,
		evaluated_at: new Date(now).toISOString(),
		evidence,
		successful_contact: contact
			? {
					activity_id: contact.id,
					occurred_at: contact.occurred_at,
					source: contact.source,
					kind: contact.kind,
				}
			: null,
		usable_route: route ? { flag_id: route.flag_id, kind: route.kind } : null,
		contact_freshness_days: FRESHNESS_DAYS,
		source_inputs: input,
	};
}
