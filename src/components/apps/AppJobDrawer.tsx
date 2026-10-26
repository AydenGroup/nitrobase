import { ActionLogDrawer } from "#/components/servers/ActionLogDrawer";

export const AppJobDrawer: React.FC<{
	job: { id: string; title: string } | null;
	appName: string;
	onClose: () => void;
	onCompleted: (success: boolean) => void;
}> = ({ job, appName, onClose, onCompleted }) => (
	<ActionLogDrawer
		opened={job !== null}
		onClose={onClose}
		serverName={appName}
		title={job?.title}
		deploymentId={job?.id ?? null}
		onCompleted={onCompleted}
	/>
);
