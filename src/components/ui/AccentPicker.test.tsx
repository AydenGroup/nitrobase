import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccentPicker } from "./AccentPicker";

const i18n = setupI18n();
i18n.loadAndActivate({ locale: "en", messages: {} });

const render = (value: Parameters<typeof AccentPicker>[0]["value"]) =>
	renderToStaticMarkup(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<AccentPicker value={value} onChange={() => {}} />
			</MantineProvider>
		</I18nProvider>,
	);

describe("AccentPicker", () => {
	it("renders six radios in one radiogroup", () => {
		const html = render("mono");
		expect(html.match(/role="radio"/g)).toHaveLength(6);
		expect(html.match(/role="radiogroup"/g)).toHaveLength(1);
	});

	it("marks exactly the selected accent as checked", () => {
		const html = render("violet");
		expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
		expect(html).toMatch(
			/aria-label="Violet"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="Violet"/,
		);
	});

	it("names every dot for screen readers", () => {
		const html = render("mono");
		for (const name of [
			"Monochrome",
			"Emerald",
			"Blue",
			"Violet",
			"Orange",
			"Pink",
		]) {
			expect(html).toContain(`aria-label="${name}"`);
		}
	});
});
