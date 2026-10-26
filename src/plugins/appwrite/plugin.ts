import { msg } from "@lingui/core/macro";
import { CloudUpload } from "lucide-react";
import type { ProviderPlugin } from "../types";

/** Appwrite: cloud sync (import origin, export to Appwrite Cloud, history). */
export const appwritePlugin: ProviderPlugin = {
	templateId: "appwrite",
	capabilities: ["cloud-sync"],
	tabs: [
		{
			id: "appwrite-cloud-sync",
			label: msg({ id: "Cloud sync" }),
			icon: CloudUpload,
			capability: "cloud-sync",
			load: () => import("#/components/cloud-sync/CloudSyncTab"),
		},
	],
};
