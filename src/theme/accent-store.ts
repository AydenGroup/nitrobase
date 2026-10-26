import { useSyncExternalStore } from "react";
import {
	ACCENT_ATTRIBUTE,
	ACCENT_STORAGE_KEY,
	type AccentId,
	DEFAULT_ACCENT,
	parseAccent,
} from "./accents";

/** localStorage, or undefined where it is missing or blocked (SSR, private window). */
const browserStorage = (): Storage | undefined => {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
};

/**
 * Applies the accent (`data-accent` on `<html>`) and stores it. A storage
 * failure (quota, blocked) does not undo the visible change.
 */
export const writeAccent = (
	id: AccentId,
	doc: { documentElement: Pick<HTMLElement, "setAttribute"> } = document,
	storage: Pick<Storage, "setItem"> | undefined = browserStorage(),
): void => {
	doc.documentElement.setAttribute(ACCENT_ATTRIBUTE, id);
	try {
		storage?.setItem(ACCENT_STORAGE_KEY, id);
	} catch {
		// Not persisted: the choice lasts until the page is closed.
	}
};

/**
 * The accent to show after a `storage` event from another tab: the new value
 * of the accent key, the default when storage is cleared, `undefined` for
 * other keys.
 */
export const accentFromStorageEvent = (event: {
	key: string | null;
	newValue: string | null;
}): AccentId | undefined => {
	if (event.key === null) return DEFAULT_ACCENT;
	if (event.key !== ACCENT_STORAGE_KEY) return undefined;
	return parseAccent(event.newValue);
};

const listeners = new Set<() => void>();

const setAccent = (id: AccentId): void => {
	writeAccent(id);
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		const next = accentFromStorageEvent(event);
		if (next === undefined) return;
		document.documentElement.setAttribute(ACCENT_ATTRIBUTE, next);
		listener();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
};

// The attribute is the source of truth: the boot script sets it before paint.
const getSnapshot = (): AccentId =>
	parseAccent(document.documentElement.getAttribute(ACCENT_ATTRIBUTE));

const getServerSnapshot = (): AccentId => DEFAULT_ACCENT;

/** The current accent and a setter; follows changes made in other tabs. */
export const useAccent = (): readonly [AccentId, (id: AccentId) => void] => {
	const accent = useSyncExternalStore(
		subscribe,
		getSnapshot,
		getServerSnapshot,
	);
	return [accent, setAccent] as const;
};
