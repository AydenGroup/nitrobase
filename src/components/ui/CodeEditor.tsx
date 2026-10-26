import { useLingui } from "@lingui/react";
import { Center, Loader, Paper } from "@mantine/core";
import { lazy, Suspense, useEffect, useState } from "react";

/** Monaco is heavy and browser-only: its own chunk, loaded after mount. */
const MonacoEditor = lazy(() => import("./CodeEditorMonaco"));

export type CodeLanguage = "typescript" | "javascript" | "pgsql" | "plaintext";

export interface CodeEditorProps {
	value: string;
	onChange?: (value: string) => void;
	language: CodeLanguage;
	readOnly?: boolean;
	/** CSS height, e.g. 420 or "60vh". */
	height?: number | string;
	/** Accessible name of the editor. */
	label?: string;
}

/** Code editor (Monaco), lazy-loaded and client-only. */
export const CodeEditor: React.FC<CodeEditorProps> = (props) => {
	const { i18n } = useLingui();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const height = props.height ?? 420;
	const fallback = (
		<Center h={height} aria-label={i18n._("Loading editor")}>
			<Loader size="sm" />
		</Center>
	);
	return (
		<Paper withBorder radius="sm" style={{ overflow: "hidden" }}>
			{mounted ? (
				<Suspense fallback={fallback}>
					<MonacoEditor {...props} height={height} />
				</Suspense>
			) : (
				fallback
			)}
		</Paper>
	);
};
