// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider, Textarea } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyField } from "./CopyField";
import { CopyButton, CopyIconButton } from "./CopyIconButton";

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

const i18n = setupI18n();
i18n.loadAndActivate({ locale: "en", messages: {} });

const renderWithProviders = (ui: ReactNode) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>{ui}</MantineProvider>
		</I18nProvider>,
	);

const originalClipboard = Object.getOwnPropertyDescriptor(
	navigator,
	"clipboard",
);
const originalExecCommand = document.execCommand;

afterEach(() => {
	cleanup();
	if (originalClipboard) {
		Object.defineProperty(navigator, "clipboard", originalClipboard);
	} else {
		Reflect.deleteProperty(navigator, "clipboard");
	}
	document.execCommand = originalExecCommand;
});

describe("CopyIconButton and CopyButton", () => {
	it("copies with navigator.clipboard.writeText when available", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		renderWithProviders(<CopyField value="postgres://user:pass@db:5432/app" />);
		const button = screen.getByRole("button", { name: "Copy" });
		fireEvent.click(button);

		expect(writeText).toHaveBeenCalledWith("postgres://user:pass@db:5432/app");
		await waitFor(() => {
			expect(button.getAttribute("style")).toContain("--ai-color");
		});
	});

	it("falls back to document.execCommand('copy') over plain HTTP where navigator.clipboard is undefined", () => {
		Reflect.deleteProperty(navigator, "clipboard");

		let selectedDuringCopy = "";
		let containerRoleDuringCopy = "";
		document.execCommand = vi.fn((command: string) => {
			expect(command).toBe("copy");
			const active = document.activeElement as HTMLTextAreaElement | null;
			selectedDuringCopy =
				active?.value.slice(
					active.selectionStart ?? 0,
					active.selectionEnd ?? 0,
				) ?? "";
			containerRoleDuringCopy =
				active?.parentElement?.getAttribute("role") ?? "";
			return true;
		});

		renderWithProviders(
			<div role="dialog" aria-modal="true">
				<CopyButton value="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test@host">
					{({ copied, copy }) => (
						<button type="button" onClick={copy}>
							{copied ? "Copied" : "Copy key"}
						</button>
					)}
				</CopyButton>
			</div>,
		);

		const button = screen.getByRole("button", { name: "Copy key" });
		button.focus();
		fireEvent.click(button);

		expect(document.execCommand).toHaveBeenCalledWith("copy");
		expect(selectedDuringCopy).toBe(
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test@host",
		);
		expect(containerRoleDuringCopy).toBe("dialog");
		expect(document.querySelectorAll("textarea")).toHaveLength(0);
		expect(document.activeElement).toBe(button);
		expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
	});

	it("falls back to document.execCommand('copy') when navigator.clipboard.writeText rejects", async () => {
		const writeText = vi
			.fn()
			.mockRejectedValue(new Error("Write permission denied"));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		let copiedText = "";
		document.execCommand = vi.fn(() => {
			const active = document.activeElement as HTMLTextAreaElement | null;
			copiedText = active?.value ?? "";
			return true;
		});

		renderWithProviders(
			<CopyButton value="secret-recovery-code">
				{({ copied, copy }) => (
					<button type="button" onClick={copy}>
						{copied ? "Copied" : "Copy"}
					</button>
				)}
			</CopyButton>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Copy" }));

		await waitFor(() => {
			expect(copiedText).toBe("secret-recovery-code");
			expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
		});
	});

	it("keeps pointer events enabled when rendered inside a Textarea rightSection", () => {
		renderWithProviders(
			<Textarea
				label="Public Key"
				value="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"
				onChange={() => {}}
				rightSection={
					<CopyIconButton
						value="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"
						label="Copy public key"
					/>
				}
				rightSectionPointerEvents="all"
			/>,
		);

		const button = screen.getByRole("button", { name: "Copy public key" });
		expect(button.style.pointerEvents).toBe("auto");
	});
});
