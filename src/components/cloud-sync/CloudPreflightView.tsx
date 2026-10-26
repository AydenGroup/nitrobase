import { useLingui } from "@lingui/react";
import { Alert, Stack } from "@mantine/core";
import { CodedList } from "#/components/ui/CodedList";
import { KeyValueList } from "#/components/ui/KeyValueList";
import {
	type CloudSyncProvider,
	preflightCountUnits,
	syncPartLabel,
} from "#/config/cloud-sync.ts";
import type { CloudPreflight } from "#/features/cloud-sync/schema.ts";
import { formatBytes, formatList } from "#/libs/intl.ts";

/**
 * What a sync will copy and what will not carry over: an import's cloud
 * contents, or an export's app contents and the (empty) cloud project.
 */
export const CloudPreflightView: React.FC<{
	provider: CloudSyncProvider;
	preflight: CloudPreflight;
}> = ({ provider, preflight }) => {
	const { i18n } = useLingui();
	const exporting = preflight.direction === "export";
	const bytes = (value: number) => formatBytes(i18n.locale, value);
	const content = (row: CloudPreflight["contents"][number]) => {
		const counts = row.counts.map((item) => {
			const text = i18n._({
				...preflightCountUnits[item.unit],
				values: { count: item.count },
			});
			return item.atLeast ? i18n._("at least {count}", { count: text }) : text;
		});
		const values = [
			...(row.sizeBytes !== null ? [bytes(row.sizeBytes)] : []),
			...counts,
			...(row.names ? [row.names.length > 0 ? row.names.join(", ") : ""] : []),
		].filter(Boolean);
		return values.length > 0
			? formatList(i18n.locale, values, "unit")
			: i18n._("none");
	};
	const partLabel = (part: string) => {
		const label = syncPartLabel(provider, part);
		return label ? i18n._(label) : part;
	};
	const cloudEmpty = (preflight.cloud ?? []).every(
		(row) =>
			row.counts.every((item) => item.count === 0) &&
			(row.names?.length ?? 0) === 0,
	);
	const versions =
		preflight.versions.target === null
			? preflight.versions.source
			: exporting
				? i18n._("{source} in the cloud, {target} in this app", {
						source: preflight.versions.source,
						target: preflight.versions.target,
					})
				: i18n._("{source} in the cloud, {target} in the new app", {
						source: preflight.versions.source,
						target: preflight.versions.target,
					});
	const items = [
		{
			key: "project",
			label: i18n._("Project"),
			value: `${preflight.project.name} (${preflight.project.id}${preflight.project.region ? `, ${preflight.project.region}` : ""})`,
		},
		{ key: "version", label: i18n._(provider.versionLabel), value: versions },
		...preflight.contents.map((row) => ({
			key: `part-${row.part}`,
			label: exporting
				? i18n._("{part} in this app", { part: partLabel(row.part) })
				: partLabel(row.part),
			value: content(row),
		})),
		...(preflight.cloud
			? [
					{
						key: "cloud",
						label: i18n._("Cloud project now"),
						value: cloudEmpty
							? i18n._("empty")
							: formatList(
									i18n.locale,
									preflight.cloud.map(
										(row) => `${partLabel(row.part)}: ${content(row)}`,
									),
								),
					},
				]
			: []),
		{
			key: "disk",
			label: i18n._("Disk on {server}", {
				server: preflight.target.serverName,
			}),
			value:
				preflight.target.freeDiskBytes !== null
					? i18n._("about {required} needed, {free} free", {
							required: bytes(preflight.requiredDiskBytes),
							free: bytes(preflight.target.freeDiskBytes),
						})
					: i18n._("about {required} needed", {
							required: bytes(preflight.requiredDiskBytes),
						}),
		},
	];
	return (
		<Stack gap="sm">
			<KeyValueList items={items} />
			{preflight.blockers.length > 0 && (
				<Alert
					color="red"
					title={
						exporting
							? i18n._("The export cannot start")
							: i18n._("The import cannot start")
					}
				>
					<CodedList items={preflight.blockers} size="sm" />
				</Alert>
			)}
			{preflight.warnings.length > 0 && (
				<Alert
					color="yellow"
					title={
						exporting
							? i18n._("Before you export")
							: i18n._("Before you import")
					}
				>
					<CodedList items={preflight.warnings} size="sm" />
				</Alert>
			)}
		</Stack>
	);
};
