import { appwriteDriver } from "./appwrite";
import { supabaseDriver } from "./supabase";
import type { CloudSyncDriver } from "./types";

/**
 * Server drivers by provider id (`cloudSyncProviders` in
 * #/config/cloud-sync.ts). A provider without a driver here cannot be used.
 */
export const cloudSyncDrivers: Record<string, CloudSyncDriver> = {
	supabase: supabaseDriver,
	appwrite: appwriteDriver,
};

export function cloudSyncDriver(provider: string): CloudSyncDriver | null {
	return cloudSyncDrivers[provider] ?? null;
}
