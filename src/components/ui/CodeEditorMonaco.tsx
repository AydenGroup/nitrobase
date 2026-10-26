import { useComputedColorScheme } from "@mantine/core";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/pgsql/register";
import "monaco-editor/languages/definitions/typescript/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { CodeEditorProps } from "./CodeEditor";

// Bundled Monaco (no CDN): only the core editor worker and the languages above.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export default function CodeEditorMonaco({
	value,
	onChange,
	language,
	readOnly = false,
	height,
	label,
}: CodeEditorProps) {
	const scheme = useComputedColorScheme("dark");
	return (
		<Editor
			value={value}
			onChange={(next) => onChange?.(next ?? "")}
			language={language}
			height={height}
			theme={scheme === "dark" ? "vs-dark" : "vs"}
			options={{
				readOnly,
				ariaLabel: label,
				minimap: { enabled: false },
				fontSize: 13,
				tabSize: 2,
				scrollBeyondLastLine: false,
				automaticLayout: true,
				wordWrap: "on",
			}}
		/>
	);
}
