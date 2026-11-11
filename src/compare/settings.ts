export class SettingsError extends Error {}

// RFC 6265 cookie-octet: no whitespace, controls, quote, comma, semicolon or backslash.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

export function readSettings(env: Record<string, string | undefined>) {
	const target = env.COMPARE_TARGET;
	if (target !== "staging" && target !== "production")
		throw new SettingsError("Set COMPARE_TARGET to staging or production.");
	if (target === "production" && env.COMPARE_CONFIRM_PRODUCTION !== "read-only")
		throw new SettingsError(
			"Set COMPARE_CONFIRM_PRODUCTION=read-only to compare on production.",
		);
	const session = env.COMPARE_SESSION;
	if (!session || !COOKIE_VALUE.test(session))
		throw new SettingsError("Set COMPARE_SESSION to the session cookie value.");
	const app = URL.parse(env.COMPARE_APP_URL ?? "");
	if (app?.protocol !== "https:" || app.href !== `${app.origin}/`)
		throw new SettingsError(
			"Set COMPARE_APP_URL to the app's https base URL, with no path, query or fragment.",
		);
	return { target, app, session };
}
