export class SettingsError extends Error {}

export function readSettings(env: Record<string, string | undefined>) {
	const target = env.COMPARE_TARGET;
	if (target !== "staging" && target !== "production")
		throw new SettingsError("Set COMPARE_TARGET to staging or production.");
	if (target === "production" && env.COMPARE_CONFIRM_PRODUCTION !== "read-only")
		throw new SettingsError(
			"Set COMPARE_CONFIRM_PRODUCTION=read-only to compare on production.",
		);
	const session = env.COMPARE_SESSION;
	if (!session)
		throw new SettingsError("Set COMPARE_SESSION to the session cookie value.");
	const app = URL.parse(env.COMPARE_APP_URL ?? "");
	if (app?.protocol !== "https:")
		throw new SettingsError("Set COMPARE_APP_URL to the app's https base URL.");
	return { target, app, session };
}
