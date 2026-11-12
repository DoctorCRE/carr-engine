export const sqlState = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	typeof error.code === "string" &&
	/^[0-9A-Z]{5}$/.test(error.code)
		? error.code
		: undefined;

// Only the SQLSTATE or the error's class name: messages and details can carry
// the request's input or row values.
export const failureKind = (error: unknown) =>
	sqlState(error) ??
	(error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)
		? error.name
		: "unknown");
