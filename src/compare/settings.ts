export class SettingsError extends Error {}

function httpsUrl(value: string | undefined, name: string): URL {
	const url = URL.parse(value ?? "");
	if (url?.protocol !== "https:")
		throw new SettingsError(`Set ${name} to the https base URL.`);
	return url;
}

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
	return {
		target,
		engine: httpsUrl(env.COMPARE_ENGINE_URL, "COMPARE_ENGINE_URL"),
		old: httpsUrl(env.COMPARE_OLD_URL, "COMPARE_OLD_URL"),
		session,
	};
}
