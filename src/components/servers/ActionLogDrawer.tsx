import { useLingui } from "@lingui/react";
import {
	Badge,
	Button,
	Drawer,
	Group,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { DeploymentStatusBadge } from "#/components/dashboard/StatusBadge";
import { ErrorText } from "#/components/ui/ErrorText.tsx";
import { LogViewer } from "#/components/ui/LogViewer";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { cancelJobFn } from "#/features/deployments/deployments.functions.ts";
import type { DeploymentStatus } from "#/features/servers/schema";
import type { ErrorInfo } from "#/libs/coded.ts";
import { closeOnSessionEnded } from "#/libs/session-ended.ts";

export interface ActionLogDrawerProps {
	opened: boolean;
	onClose: () => void;
	serverName: string;
	title?: string;
	/** Deployment to stream; works for running and finished jobs alike. */
	deploymentId: string | null;
	onCompleted?: (success: boolean) => void;
}

type LogEntry = {
	seq: number;
	line: string;
	code?: string | null;
	params?: Record<string, unknown> | null;
};

/**
 * Right-side drawer that streams a job's log lines over SSE and shows its
 * live status, with a cancel action while it runs. `onCompleted` fires once
 * when the stream reports the final status.
 */
export function ActionLogDrawer({
	opened,
	onClose,
	serverName,
	title,
	deploymentId,
	onCompleted,
}: ActionLogDrawerProps) {
	const { i18n } = useLingui();
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [status, setStatus] = useState<DeploymentStatus>("pending");
	const [error, setError] = useState<Partial<ErrorInfo> | null>(null);
	const cancel = useAppMutation({
		mutationFn: (id: string) => cancelJobFn({ data: id }),
		success: (result) =>
			result.deferred
				? i18n._("Cancelling after the current step...")
				: result.cancelled
					? i18n._("Cancelling the job...")
					: null,
	});
	// Latest callback in a ref so a new parent closure doesn't restart the stream.
	const onCompletedRef = useRef(onCompleted);
	onCompletedRef.current = onCompleted;

	useEffect(() => {
		if (!opened || !deploymentId) return;
		setLogs([]);
		setError(null);
		setStatus("running");

		// EventSource resumes with Last-Event-ID after transient drops.
		const es = new EventSource(
			`/api/deployments/${encodeURIComponent(deploymentId)}/stream`,
		);
		closeOnSessionEnded(es);

		es.addEventListener("log", (e) => {
			const seq = Number((e as MessageEvent).lastEventId) || 0;
			let entry: Omit<LogEntry, "seq">;
			try {
				const data = JSON.parse((e as MessageEvent).data) as
					| string
					| Omit<LogEntry, "seq">;
				entry = typeof data === "string" ? { line: data } : data;
			} catch {
				entry = { line: (e as MessageEvent).data };
			}
			setLogs((prev) =>
				seq && prev.length && prev[prev.length - 1].seq >= seq
					? prev
					: [...prev, { seq, ...entry }],
			);
		});

		es.addEventListener("complete", (e) => {
			es.close();
			try {
				const payload = JSON.parse((e as MessageEvent).data) as {
					status: "success" | "failed";
					errorMessage: string | null;
					error?: Partial<ErrorInfo> | null;
				};
				setStatus(payload.status);
				setError(
					payload.error ??
						(payload.errorMessage ? { text: payload.errorMessage } : null),
				);
				onCompletedRef.current?.(payload.status === "success");
			} catch {
				setStatus("failed");
				onCompletedRef.current?.(false);
			}
		});

		es.addEventListener("failure", (e) => {
			es.close();
			try {
				const payload = JSON.parse((e as MessageEvent).data) as {
					message: string;
					error?: Partial<ErrorInfo>;
				};
				setError(payload.error ?? { text: payload.message });
			} catch {
				// ignore malformed payload
			}
			setStatus("failed");
		});

		es.addEventListener("error", () => {
			// CLOSED means the server refused the stream (404/401); otherwise
			// the browser is reconnecting on its own.
			if (es.readyState === EventSource.CLOSED) {
				setError({ text: i18n._("Could not open the log stream.") });
				setStatus((prev) => (prev === "running" ? "failed" : prev));
			}
		});

		return () => es.close();
	}, [opened, deploymentId, i18n]);

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size="xl"
			title={
				<Group gap="sm">
					<Title order={4}>{title ?? i18n._("Action log")}</Title>
					<DeploymentStatusBadge status={status} />
				</Group>
			}
		>
			<Stack gap="md">
				<Group justify="space-between">
					<Text size="sm" c="dimmed">
						{serverName}
					</Text>
					{deploymentId && (
						<Badge variant="outline" size="xs">
							{deploymentId.slice(0, 8)}
						</Badge>
					)}
				</Group>
				<LogViewer
					entries={logs.map(({ seq, ...entry }, index) => ({
						key: seq || `i${index}`,
						...entry,
					}))}
					height="calc(100dvh - 210px)"
					format="job"
					toolbar={{
						filter: true,
						search: true,
						copy: true,
						download: deploymentId ? `job-${deploymentId.slice(0, 8)}` : "job",
					}}
				/>
				{error && status === "failed" && <ErrorText c="red" error={error} />}
				<Group justify="flex-end">
					{deploymentId && status === "running" && (
						<Button
							color="red"
							variant="light"
							loading={cancel.isPending}
							disabled={cancel.isSuccess}
							onClick={() => cancel.mutate(deploymentId)}
						>
							{i18n._("Cancel job")}
						</Button>
					)}
					<Button variant="default" onClick={onClose}>
						{i18n._("Close")}
					</Button>
				</Group>
			</Stack>
		</Drawer>
	);
}
