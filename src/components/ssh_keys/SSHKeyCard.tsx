import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Badge,
	Button,
	Card,
	CopyButton,
	Group,
	Menu,
	Stack,
	Text,
	ThemeIcon,
	Tooltip,
} from "@mantine/core";
import {
	Calendar,
	Check,
	Copy,
	EllipsisVertical,
	KeyRound,
	Pencil,
	Server,
	Trash2,
} from "lucide-react";
import { CopyIconButton } from "#/components/ui/CopyIconButton";
import { LocalDate } from "#/components/ui/LocalDate";
import { sshKeyTypes } from "#/config/ssh-key-types.ts";
import type { SSHKeyDTO } from "#/features/ssh_keys/schema.ts";
import { formatList } from "#/libs/intl.ts";

/**
 * SSH key card: name, type, description, fingerprint, which servers use
 * it and a copy-public-key action. A key in use can't be deleted (the
 * server refuses too), so Delete is disabled with the reason.
 */
export const SSHKeyCard: React.FC<{
	sshKey: SSHKeyDTO;
	/** Names of the servers using the key; undefined when not visible. */
	usedBy?: string[];
	manage: boolean;
	deleting: boolean;
	onEdit: () => void;
	onDelete: () => void;
}> = ({ sshKey, usedBy, manage, deleting, onEdit, onDelete }) => {
	const { i18n } = useLingui();
	const inUse = (usedBy?.length ?? 0) > 0;
	const isEd25519 = sshKey.keyType === "ed25519";
	const keyColor = isEd25519 ? "teal" : "gray";

	return (
		<Card
			p={0}
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100%",
			}}
		>
			<Stack gap="md" p="md" justify="space-between" style={{ flex: 1 }}>
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
						<ThemeIcon
							variant="light"
							color={keyColor}
							size="lg"
							radius="md"
							style={{ flexShrink: 0 }}
						>
							<KeyRound size={18} />
						</ThemeIcon>
						<Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
							<Group gap={6} wrap="nowrap" align="center">
								<Tooltip
									label={sshKey.name}
									disabled={sshKey.name.length < 20}
									withArrow
									openDelay={300}
								>
									<Text fw={600} truncate style={{ minWidth: 0 }}>
										{sshKey.name}
									</Text>
								</Tooltip>
								<Badge
									size="xs"
									variant="light"
									color={keyColor}
									style={{ flexShrink: 0 }}
								>
									{sshKeyTypes[sshKey.keyType]?.label ?? sshKey.keyType}
								</Badge>
							</Group>
							{sshKey.description && (
								<Text
									size="xs"
									c="dimmed"
									lineClamp={2}
									title={sshKey.description}
								>
									{sshKey.description}
								</Text>
							)}
						</Stack>
					</Group>
					{manage && (
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<ActionIcon
									variant="subtle"
									color="gray"
									loading={deleting}
									aria-label={i18n._("Actions for {name}", {
										name: sshKey.name,
									})}
									style={{ flexShrink: 0 }}
								>
									<EllipsisVertical size={16} />
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Item leftSection={<Pencil size={14} />} onClick={onEdit}>
									{i18n._("Edit")}
								</Menu.Item>
								<Menu.Item
									color="red"
									leftSection={<Trash2 size={14} />}
									onClick={onDelete}
									disabled={inUse}
								>
									{inUse ? i18n._("In use, can't delete") : i18n._("Delete")}
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					)}
				</Group>

				<Stack gap={6} mt="auto">
					<Text size="xs" c="dimmed" fw={500}>
						{i18n._("Fingerprint")}
					</Text>
					<Group
						gap="xs"
						wrap="nowrap"
						px="xs"
						py={6}
						style={{
							backgroundColor: "var(--mantine-color-default-hover)",
							border: "1px solid var(--mantine-color-default-border)",
							borderRadius: "var(--mantine-radius-sm)",
						}}
					>
						<Text
							size="xs"
							ff="monospace"
							truncate
							style={{
								flex: 1,
								minWidth: 0,
								fontSize: "0.75rem",
								userSelect: "all",
							}}
						>
							{sshKey.fingerprint}
						</Text>
						<CopyIconButton
							value={sshKey.fingerprint}
							label={i18n._("Copy fingerprint")}
							size={13}
						/>
					</Group>
				</Stack>
			</Stack>

			<Group
				justify="space-between"
				gap="sm"
				px="md"
				py="xs"
				wrap="nowrap"
				style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
			>
				<Group gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
					{usedBy && (
						<Tooltip
							label={formatList(i18n.locale, usedBy)}
							disabled={!inUse}
							withArrow
							multiline
							maw={280}
						>
							<Group gap={6} wrap="nowrap">
								<Server
									size={13}
									aria-hidden
									style={{
										color: inUse ? "var(--mantine-color-teal-text)" : undefined,
										flexShrink: 0,
									}}
								/>
								<Text size="xs" c={inUse ? undefined : "dimmed"} truncate>
									{inUse
										? i18n._(
												"{count, plural, one {Used by # server} other {Used by # servers}}",
												{ count: usedBy.length },
											)
										: i18n._("Not used")}
								</Text>
							</Group>
						</Tooltip>
					)}
					<Group gap={4} wrap="nowrap" visibleFrom="xs">
						<Calendar size={13} aria-hidden style={{ flexShrink: 0 }} />
						<Text size="xs" c="dimmed">
							<LocalDate
								value={sshKey.createdAt}
								options={{ dateStyle: "medium" }}
							/>
						</Text>
					</Group>
				</Group>
				<CopyButton value={sshKey.publicKey} timeout={1500}>
					{({ copied, copy }) => (
						<Tooltip
							label={
								copied
									? i18n._("Copied to clipboard")
									: i18n._("Copy public key to clipboard")
							}
							withArrow
						>
							<Button
								size="compact-xs"
								variant="light"
								color={copied ? "teal" : undefined}
								leftSection={copied ? <Check size={12} /> : <Copy size={12} />}
								onClick={copy}
								style={{ flexShrink: 0 }}
							>
								{copied ? i18n._("Copied") : i18n._("Public key")}
							</Button>
						</Tooltip>
					)}
				</CopyButton>
			</Group>
		</Card>
	);
};
