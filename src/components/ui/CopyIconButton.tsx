import { useLingui } from "@lingui/react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Copy `value` with `document.execCommand("copy")` through an off-screen
 * `<textarea>`. Used when `navigator.clipboard` is unavailable (plain HTTP
 * such as `http://<server-ip>:3000`) or rejects.
 */
function execCommandCopy(value: string): boolean {
	if (typeof document === "undefined" || !document.body) return false;
	const active =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	// Stay inside an open modal/drawer so its focus trap does not pull focus
	// back before `select()` + `execCommand("copy")` run.
	const container =
		active?.closest<HTMLElement>("[role='dialog'], [aria-modal='true']") ??
		document.body;

	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.setAttribute("readonly", "");
	textarea.setAttribute("aria-hidden", "true");
	textarea.tabIndex = -1;
	Object.assign(textarea.style, {
		position: "fixed",
		top: "0",
		left: "0",
		width: "1px",
		height: "1px",
		padding: "0",
		border: "0",
		opacity: "0",
		pointerEvents: "none",
	});

	container.appendChild(textarea);
	try {
		textarea.focus({ preventScroll: true });
		textarea.select();
		textarea.setSelectionRange(0, value.length);
		return typeof document.execCommand === "function"
			? document.execCommand("copy")
			: false;
	} catch {
		return false;
	} finally {
		textarea.remove();
		active?.focus({ preventScroll: true });
	}
}

/**
 * Clipboard state hook with a fallback to `document.execCommand("copy")` when
 * `navigator.clipboard` is missing (plain HTTP) or rejects.
 */
export function useClipboard({ timeout = 2000 }: { timeout?: number } = {}) {
	const [error, setError] = useState<Error | null>(null);
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timeoutRef.current !== null) {
				window.clearTimeout(timeoutRef.current);
			}
		},
		[],
	);

	const markCopied = () => {
		setError(null);
		if (timeoutRef.current !== null) {
			window.clearTimeout(timeoutRef.current);
		}
		timeoutRef.current = window.setTimeout(() => setCopied(false), timeout);
		setCopied(true);
	};

	const failCopy = (cause?: unknown) => {
		setError(
			cause instanceof Error
				? cause
				: new Error("useClipboard: failed to copy to clipboard"),
		);
	};

	const copy = (valueToCopy: string) => {
		if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
			navigator.clipboard
				.writeText(valueToCopy)
				.then(markCopied)
				.catch((err) => {
					if (execCommandCopy(valueToCopy)) markCopied();
					else failCopy(err);
				});
		} else if (execCommandCopy(valueToCopy)) {
			markCopied();
		} else {
			failCopy();
		}
	};

	const reset = () => {
		setCopied(false);
		setError(null);
		if (timeoutRef.current !== null) {
			window.clearTimeout(timeoutRef.current);
		}
	};

	return { copy, reset, error, copied };
}

/** Render-prop copy helper that works on both HTTPS/localhost and plain HTTP. */
export const CopyButton: React.FC<{
	value: string;
	timeout?: number;
	children: (payload: { copied: boolean; copy: () => void }) => ReactNode;
}> = ({ value, timeout = 1000, children }) => {
	const clipboard = useClipboard({ timeout });
	return (
		<>
			{children({
				copied: clipboard.copied,
				copy: () => clipboard.copy(value),
			})}
		</>
	);
};

/**
 * Icon button copying `value` (read at click time from the latest render),
 * with a tooltip, an accessible name (`label`, default "Copy") and a copied
 * state.
 */
export const CopyIconButton: React.FC<{
	value: string;
	size?: number;
	label?: string;
}> = ({ value, size = 14, label }) => {
	const { i18n } = useLingui();
	const name = label ?? i18n._("Copy");
	return (
		<CopyButton value={value} timeout={1500}>
			{({ copied, copy }) => (
				<Tooltip label={copied ? i18n._("Copied") : name} withArrow>
					<ActionIcon
						variant="subtle"
						color={copied ? "green" : "gray"}
						onClick={copy}
						aria-label={name}
						disabled={!value}
						style={{ pointerEvents: "auto" }}
					>
						{copied ? <Check size={size} /> : <Copy size={size} />}
					</ActionIcon>
				</Tooltip>
			)}
		</CopyButton>
	);
};
