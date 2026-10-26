import { useState } from "react";

export interface FolderFile {
	path: string;
	content: string;
}

/** Working copy of a folder's files: the saved ones until the first edit. */
export function useFolderFiles(source: FolderFile[] | undefined) {
	const [edited, setEdited] = useState<FolderFile[] | null>(null);
	return {
		working: edited ?? source ?? [],
		dirty: edited !== null,
		setFiles: setEdited,
		discard: () => setEdited(null),
	};
}

export type FolderFiles = ReturnType<typeof useFolderFiles>;
