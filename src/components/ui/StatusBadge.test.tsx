import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deploymentStatuses } from "#/config/status.ts";
import { StatusBadge, StatusDot } from "./StatusBadge";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });

const renderHtml = (element: React.ReactElement) =>
	renderToStaticMarkup(
		<I18nProvider i18n={i18n}>
			<MantineProvider>{element}</MantineProvider>
		</I18nProvider>,
	);

describe("StatusBadge and StatusDot", () => {
	it("colors the status dot green for running/progress statuses instead of brand.6", () => {
		const html = renderHtml(<StatusBadge meta={deploymentStatuses.running} />);
		expect(html).toContain("var(--mantine-color-green-6)");
		expect(html).not.toContain("var(--mantine-color-brand-6)");
	});

	it("preserves tone colors for other status dots", () => {
		const html = renderHtml(<StatusDot meta={deploymentStatuses.failed} />);
		expect(html).toContain("var(--mantine-color-red-6)");
	});
});
