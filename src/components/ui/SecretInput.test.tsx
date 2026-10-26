import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecretInput } from "./SecretInput";

/** The rendered `<input>` tag of a secret input. */
const inputTag = (element: React.ReactElement) => {
	const html = renderToStaticMarkup(
		<MantineProvider>{element}</MantineProvider>,
	);
	const tag = html.match(/<input[^>]*>/)?.[0];
	if (!tag) throw new Error("no input rendered");
	return tag;
};

describe("SecretInput (BUG-001)", () => {
	it("opts out of browser and password-manager autofill on the input", () => {
		const tag = inputTag(<SecretInput label="Passphrase" />);
		expect(tag).toContain('type="password"');
		expect(tag).toContain('autoComplete="new-password"');
		expect(tag).toContain('data-1p-ignore="true"');
		expect(tag).toContain('data-lpignore="true"');
		expect(tag).toContain('data-bwignore="true"');
		expect(tag).toContain('data-form-type="other"');
	});

	it("keeps the opt-outs even when a caller passes another autocomplete", () => {
		const tag = inputTag(
			<SecretInput label="Password" autoComplete="current-password" />,
		);
		expect(tag).toContain('autoComplete="new-password"');
		expect(tag).not.toContain("current-password");
	});
});
