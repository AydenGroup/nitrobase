import { msg } from "@lingui/core/macro";
import { CloudUpload, KeyRound, SquareFunction, Zap } from "lucide-react";
import type { ProviderPlugin } from "../types";

/**
 * Supabase: API keys/Studio page (with the storage metadata repair),
 * Edge/Database Functions, cloud sync.
 */
export const supabasePlugin: ProviderPlugin = {
	templateId: "supabase",
	capabilities: [
		"api-keys",
		"studio",
		"edge-functions",
		"db-functions",
		"cloud-sync",
		"storage-repair",
	],
	tabs: [
		{
			id: "supabase-api",
			label: msg({ id: "API" }),
			icon: KeyRound,
			capability: "api-keys",
			load: () => import("#/components/supabase/SupabaseApiTab"),
		},
		{
			id: "supabase-edge-functions",
			label: msg({ id: "Edge Functions" }),
			icon: Zap,
			capability: "edge-functions",
			permission: "app.deploy",
			load: () => import("#/components/supabase/EdgeFunctionsTab"),
		},
		{
			id: "supabase-db-functions",
			label: msg({ id: "Database Functions" }),
			icon: SquareFunction,
			capability: "db-functions",
			permission: "app.database",
			load: () => import("#/components/supabase/DbFunctionsTab"),
		},
		{
			id: "supabase-cloud-sync",
			label: msg({ id: "Cloud sync" }),
			icon: CloudUpload,
			capability: "cloud-sync",
			load: () => import("#/components/cloud-sync/CloudSyncTab"),
		},
	],
};
