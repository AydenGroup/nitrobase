import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { notifications } from "#/components/ui/Notifications";
import type { StartServerActionInput } from "#/features/servers/schema.ts";
import { startServerActionFn } from "#/features/servers/servers.functions.ts";

/** Start a server job (test/bootstrap) and track the log drawer. */
export function useServerJob(serverId: string) {
	const queryClient = useQueryClient();
	const [job, setJob] = useState<{ id: string; title: string } | null>(null);
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["servers"] }),
			queryClient.invalidateQueries({ queryKey: ["jobs"] }),
		]);
	const mutation = useMutation({
		mutationFn: async (input: {
			action: StartServerActionInput["action"];
			title: string;
			takeover?: boolean;
		}) => ({
			title: input.title,
			...(await startServerActionFn({
				data: { serverId, action: input.action, takeover: input.takeover },
			})),
		}),
		onSuccess: ({ deploymentId, title }) => {
			setJob({ id: deploymentId, title });
			refresh();
		},
		onError: (error: Error) => notifications.error({ message: error.message }),
	});
	return {
		job,
		openJob: (id: string, title: string) => setJob({ id, title }),
		closeJob: () => setJob(null),
		start: mutation.mutate,
		isStarting: mutation.isPending,
		refresh,
	};
}
