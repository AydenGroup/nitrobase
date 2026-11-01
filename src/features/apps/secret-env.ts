/**
 * Names of the env variables to hide from roles that cannot reveal secrets
 * (and to mask in command output): the template's own secrets, the names
 * matching `namePattern`, and the variables whose value matches
 * `valuePattern` (a URL that carries a password, whatever the name). Pure.
 */
export function secretEnvKeys(input: {
	values: Record<string, string>;
	templateSecrets: Iterable<string>;
	namePattern: string;
	valuePattern: string;
}): Set<string> {
	const keys = new Set(input.templateSecrets);
	const secretName = new RegExp(input.namePattern);
	const secretValue = new RegExp(input.valuePattern, "i");
	for (const [name, value] of Object.entries(input.values)) {
		if (secretName.test(name) || secretValue.test(value)) keys.add(name);
	}
	return keys;
}
