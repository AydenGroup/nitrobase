import { queryOptions } from "@tanstack/react-query";
import { STALE_MS } from "#/config/polling.ts";
import { listSSHKeysFn } from "./ssh_keys.functions";

/** The user's SSH keys (no secrets). Invalidate after add/edit/delete. */
export const sshKeysQueryOptions = queryOptions({
	queryKey: ["ssh-keys"],
	queryFn: async () => await listSSHKeysFn(),
	staleTime: STALE_MS.long,
});
