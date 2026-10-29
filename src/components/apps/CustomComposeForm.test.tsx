// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomComposeAnalysis } from "#/features/templates/schema.ts";
import {
	CustomComposeForm,
	type CustomComposeValue,
} from "./CustomComposeForm";

vi.mock("#/features/apps/apps.functions.ts", () => ({
	analyzeComposeFn: vi.fn(),
}));

// Mantine reads these browser APIs, which jsdom lacks.
window.matchMedia ??= ((query: string) => ({
	matches: false,
	media: query,
	addEventListener: () => {},
	removeEventListener: () => {},
	addListener: () => {},
	removeListener: () => {},
	dispatchEvent: () => false,
	onchange: null,
})) as typeof window.matchMedia;
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};
Object.defineProperty(document, "fonts", {
	value: { addEventListener() {}, removeEventListener() {} },
	configurable: true,
});

const i18n = setupI18n();
i18n.loadAndActivate({ locale: "en", messages: {} });

const analysis: CustomComposeAnalysis = {
	services: [{ name: "web", image: "traefik/whoami:v1.10", ports: [80] }],
	volumes: [],
	fileBinds: [],
	missingEnv: [],
	error: null,
	warnings: [],
};

const start: CustomComposeValue = {
	compose: "services:\n  web:\n    image: traefik/whoami:v1.10\n",
	env: "",
	routes: [{ service: "web", port: 80 }],
	backupVolumes: [],
	dataBinds: [],
};

/** The form with its value held in state, as the deploy wizard does. */
const Harness: React.FC = () => {
	const [value, setValue] = useState(start);
	return (
		<CustomComposeForm
			templateId="custom-compose"
			value={value}
			onChange={setValue}
			analysis={analysis}
			onAnalysis={() => {}}
		/>
	);
};

const renderForm = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<Harness />
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

afterEach(cleanup);

describe("CustomComposeForm route port (BUG-029)", () => {
	it("keeps the same input while a multi-digit port is typed", () => {
		renderForm();
		const input = screen.getByLabelText<HTMLInputElement>("Container port");
		input.focus();

		for (const typed of ["8", "80", "808", "8080"]) {
			fireEvent.change(input, { target: { value: typed } });
			// A remounted input is a new element: focus and the next key are lost.
			expect(input.isConnected).toBe(true);
			expect(input).toBe(document.activeElement);
		}
		expect(input.value).toBe("8080");
	});
});
