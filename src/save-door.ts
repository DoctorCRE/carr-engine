import {
	hasToolCallMarkup,
	Refusal,
	reservedFields,
	unregisteredFields,
} from "./answer.ts";
import type { JsonObject, JsonValue } from "./database.d.ts";

// A field as the old schema declared it. The old door converted only a plain
// boolean, number or object, so a string, an untyped field and a union are
// all declared as `{}`, or `{ nullable: true }` when null counts as given. An
// array field has no declaration yet: the first save with one ports the old
// array rules first (decision 18).
type Field =
	| { type?: never; allowed?: readonly string[]; nullable?: true }
	| Typed;

// The old door checked allowed values and null only at the top level.
type Nested = { type?: never } | Typed;

type NestedFields = Readonly<Record<string, Nested>>;

// The door skips allowed and nullable on a typed field, so refuse them.
type Typed = { allowed?: never; nullable?: never } & (
	| { type: "boolean" | "number" }
	| { type: "object"; fields: NestedFields }
);

// The old schema's order picks the refusal, so never sort these.
export type Fields = Readonly<Record<string, Field>>;

export type Door<F extends Fields> = {
	verb: string;
	fields: F;
	required: readonly (keyof F & string)[];
};

export const isArguments = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Every declared name, nested ones included, as the old refusals named them.
export const declaredNames = (fields: NestedFields): string[] =>
	Object.entries(fields).flatMap(([name, field]) => [
		name,
		...(field.type === "object" ? declaredNames(field.fields) : []),
	]);

// The old door's checks in its order: reserved names, allowed values, unknown
// names, each field's markup and type, then the required fields. It answers
// the arguments as the change and the request hash see them.
export function checkDoor<F extends Fields>(
	given: JsonObject,
	{ fields, required }: Door<F>,
): Refusal | JsonObject {
	const names = Object.keys(given);
	const refused =
		reservedFields(names) ??
		strayValue(given, fields) ??
		unregisteredFields(names, Object.keys(fields));
	if (refused) return refused;
	const args = converted(fields, given, true);
	if (args instanceof Refusal) return args;
	const missing = required.filter((name) => {
		const value = args[name];
		const field = fields[name];
		if (value === null && field && !field.type && field.nullable) return false;
		return value === undefined || value === null || value === "";
	});
	return missing.length === 0
		? args
		: new Refusal(400, "missing_required", { fields: missing });
}

function strayValue(given: JsonObject, fields: Fields) {
	for (const [name, field] of Object.entries(fields)) {
		const value = given[name];
		if (field.type || !field.allowed || value === undefined || value === null)
			continue;
		if (typeof value !== "string" || !field.allowed.includes(value))
			return new Refusal(400, "value_not_in_declared_vocabulary", {
				allowed_values: field.allowed,
				fields: [name],
			});
	}
}

// A nested field is never named, because the old refusal named only
// documented names and printed a nested one as its path.
function converted(
	fields: NestedFields,
	given: JsonObject,
	top: boolean,
): Refusal | JsonObject {
	const args = { ...given };
	for (const [name, field] of Object.entries(fields)) {
		const value = args[name];
		if (value === undefined || value === null) continue;
		const named = top ? [name] : [];
		if (typeof value === "string" && hasToolCallMarkup(name, value))
			return new Refusal(400, "tool_call_markup_in_value", { fields: named });
		const typed = typedValue(field, value, named);
		if (typed instanceof Refusal) return typed;
		args[name] = typed;
	}
	return args;
}

function typedValue(
	field: Nested,
	value: JsonValue,
	named: string[],
): Refusal | JsonValue {
	const text = typeof value === "string" ? value.trim() : undefined;
	if (field.type === "boolean") {
		if (typeof value === "boolean") return value;
		if (text?.toLowerCase() === "true") return true;
		if (text?.toLowerCase() === "false") return false;
		return new Refusal(400, "invalid_boolean", { fields: named });
	}
	if (field.type === "number") {
		if (typeof value === "number") return value;
		return text && Number.isFinite(Number(text))
			? Number(text)
			: new Refusal(400, "invalid_number", { fields: named });
	}
	if (field.type === "object" && isArguments(value))
		return converted(field.fields, value, false);
	return value;
}
