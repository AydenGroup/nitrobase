import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { notifications } from "#/components/ui/Notifications";

/**
 * Start an app job and keep the log drawer state. Invalidates the app's
 * queries when the job finishes.
 */
export function useAppJob(appId: string) {
	const queryClient = useQueryClient();
	const [job, setJob] = useState<{ id: string; title: string } | null>(null);

	const refresh = () =>
		queryClient
			.invalidateQueries({ queryKey: ["apps", appId] })
			.then(() =>
				queryClient.invalidateQueries({ queryKey: ["apps"], exact: true }),
			);

	const openJob = useCallback(
		(id: string, title: string) => setJob({ id, title }),
		[],
	);

	const mutation = useMutation({
		mutationFn: async (input: {
			title: string;
			start: () => Promise<{ deploymentId: string }>;
		}) => ({ title: input.title, ...(await input.start()) }),
		onSuccess: ({ deploymentId, title }) => {
			setJob({ id: deploymentId, title });
			refresh();
		},
		onError: (error: Error) => notifications.error({ message: error.message }),
	});

	return {
		job,
		openJob,
		closeJob: () => setJob(null),
		startJob: mutation.mutate,
		isStarting: mutation.isPending,
		refresh,
	};
}
