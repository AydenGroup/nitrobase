import { useLingui } from "@lingui/react";
import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Button,
	Card,
	Code,
	Group,
	NumberInput,
	Select,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { DomainCheckBadge } from "#/components/dashboard/StatusBadge";
import { useCan } from "#/components/teams/useCan";
import { CopyIconButton } from "#/components/ui/CopyIconButton";
import { notifications } from "#/components/ui/Notifications";
import { useAppMutation } from "#/components/ui/useAppMutation";
import { renderCheckDetail, storedCheckText } from "#/config/check-details.ts";
import { domainCheckLabel } from "#/config/domain-checks.ts";
import { EXAMPLES } from "#/config/shared.ts";
import {
	addDomainFn,
	appActionFn,
	checkDomainsFn,
	removeDomainFn,
	setPrimaryDomainFn,
} from "#/features/apps/apps.functions.ts";
import {
	type AddDomainInput,
	AddDomainSchema,
	type AppOverview,
} from "#/features/apps/schema.ts";
import {
	type ExtraDomainRule,
	extraDomainRule,
} from "#/features/templates/schema.ts";
import { type ErrorInfo, errorText } from "#/libs/coded.ts";
import { translateTemplateText } from "#/libs/i18n.ts";
import { formatList } from "#/libs/intl.ts";
import { issuesToFormErrors, isZodError } from "#/utils/validate.ts";
import { AppJobDrawer } from "./AppJobDrawer";
import { useAppJob } from "./useAppJob";

/** A domain the template limits on its service/port (reason on hover). */
const LimitedBadge: React.FC<{ rule: ExtraDomainRule | null }> = ({ rule }) => {
	const { i18n } = useLingui();
	if (!rule) return null;
	return (
		<Tooltip multiline w={320} label={translateTemplateText(i18n, rule.reason)}>
			<Badge size="xs" variant="light" color="yellow">
				{i18n._("Limited")}
			</Badge>
		</Tooltip>
	);
};

export const AppDomainsTab: React.FC<{ overview: AppOverview }> = ({
	overview,
}) => {
	const { i18n } = useLingui();
	const can = useCan();
	const { app, domains } = overview;
	const queryClient = useQueryClient();
	const jobs = useAppJob(app.id);
	const services = [
		...new Set([
			...overview.services,
			...domains.map((domain) => domain.service),
		]),
	];
	const primary = domains.find((domain) => domain.primary);
	// Template rule of a domain on this service/port (null: no limit).
	const ruleFor = (target: {
		service: string;
		port: number;
		primary: boolean;
	}) => extraDomainRule(overview.extraDomainRules, target);
	const [target, setTarget] = useState({
		service: primary?.service ?? services[0] ?? "",
		port: primary?.port ?? 80,
	});
	// The first domain becomes primary: the template's rules never apply.
	const targetRule = ruleFor({ ...target, primary: domains.length === 0 });

	const form = useForm<AddDomainInput>({
		mode: "uncontrolled",
		initialValues: {
			appId: app.id,
			host: "",
			service: primary?.service ?? services[0] ?? "",
			port: primary?.port ?? 80,
			https: true,
			viaTunnel: overview.server.tunnelOnly,
		},
		validate: schemaResolver(AddDomainSchema(i18n), { sync: true }),
		onValuesChange: (values) =>
			setTarget({ service: values.service, port: Number(values.port) }),
	});

	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["apps", app.id] });
	const onError = (error: Error) => {
		if (isZodError(error)) {
			form.setErrors(issuesToFormErrors(error));
			return;
		}
		notifications.error({ message: error.message });
	};

	// DNS of the last added domain (a warning, the domain is added anyway).
	const [dnsWarning, setDnsWarning] = useState<{
		host: string;
		text: string;
	} | null>(null);
	// Template limitation of the last added domain (e.g. console sign-in).
	const [limitation, setLimitation] = useState<{
		host: string;
		info: ErrorInfo;
	} | null>(null);
	const add = useAppMutation({
		mutationFn: async (values: AddDomainInput) =>
			await addDomainFn({ data: values }),
		onSuccess: ({ deploymentId, dns, domain, limitation: limited }) => {
			form.setFieldValue("host", "");
			setLimitation(limited ? { host: domain.host, info: limited } : null);
			setDnsWarning(
				dns && dns.status !== "ok"
					? { host: domain.host, text: renderCheckDetail(i18n, dns.message) }
					: null,
			);
			refresh();
			if (deploymentId) jobs.openJob(deploymentId, i18n._("Update routes"));
		},
		success: ({ domain }) =>
			i18n._("Domain {host} added.", { host: domain.host }),
		// Refusals (taken, reserved, invalid) show under the domain field.
		field: "host",
	});
	const remove = useMutation({
		mutationFn: async (domainId: string) =>
			await removeDomainFn({ data: { appId: app.id, domainId } }),
		onSuccess: ({ deploymentId }) => {
			refresh();
			if (deploymentId) jobs.openJob(deploymentId, i18n._("Update routes"));
		},
		onError,
	});
	const makePrimary = useMutation({
		mutationFn: async (domainId: string) =>
			await setPrimaryDomainFn({ data: { appId: app.id, domainId } }),
		onSuccess: () => {
			refresh();
			notifications.info({
				message: i18n._("Primary domain changed. Redeploy to update app URLs."),
			});
		},
		onError,
	});
	const check = useMutation({
		mutationFn: async () => await checkDomainsFn({ data: app.id }),
		onSuccess: () => refresh(),
		onError,
	});

	const ipv4 = overview.server.ips.filter((ip) => !ip.includes(":"));
	const ipv6 = overview.server.ips.filter((ip) => ip.includes(":"));
	// Own domains (not free/tunnel ones) need DNS records pointing here.
	const ownDomains = domains.filter(
		(domain) =>
			!domain.provider && !domain.viaTunnel && !overview.server.tunnelOnly,
	);
	const records = ownDomains.flatMap((domain) => [
		...ipv4.map((ip) => ({ type: "A", host: domain.host, ip })),
		...ipv6.map((ip) => ({ type: "AAAA", host: domain.host, ip })),
	]);

	const applyRoutes = () =>
		jobs.startJob({
			title: i18n._("Update routes"),
			start: () => appActionFn({ data: { appId: app.id, action: "routes" } }),
		});

	return (
		<Stack gap="md">
			{app.routesPending && (
				<Alert color="yellow" title={i18n._("Routes not applied")}>
					<Group justify="space-between">
						<Text size="sm">
							{i18n._(
								"The server was busy when domains changed. Apply the routes now.",
							)}
						</Text>
						<Button
							size="xs"
							loading={jobs.isStarting}
							onClick={applyRoutes}
							display={can("app.deploy") ? undefined : "none"}
						>
							{i18n._("Apply routes")}
						</Button>
					</Group>
				</Alert>
			)}
			<Card withBorder p={0}>
				<Group justify="space-between" p="md">
					<Title order={5}>{i18n._("Domains")}</Title>
					<Button
						size="xs"
						variant="light"
						leftSection={<RefreshCw size={14} />}
						loading={check.isPending}
						onClick={() => check.mutate()}
					>
						{i18n._("Check DNS & certificates")}
					</Button>
				</Group>
				<Table>
					<Table.Thead>
						<Table.Tr>
							<Table.Th>{i18n._("Host")}</Table.Th>
							<Table.Th visibleFrom="sm">{i18n._("Service")}</Table.Th>
							<Table.Th>{i18n._("Checks")}</Table.Th>
							<Table.Th />
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{domains.map((domain) => (
							<Table.Tr key={domain.id}>
								<Table.Td>
									<Group gap="xs">
										<Anchor
											href={`${domain.https ? "https" : "http"}://${domain.host}`}
											target="_blank"
											rel="noreferrer"
											size="sm"
										>
											{domain.host}
										</Anchor>
										{domain.primary && (
											<Badge size="xs" variant="light">
												{i18n._("Primary")}
											</Badge>
										)}
										{domain.provider && (
											<Badge size="xs" variant="outline" color="gray">
												{domain.provider}
											</Badge>
										)}
										<LimitedBadge rule={ruleFor(domain)} />
										{(domain.viaTunnel || overview.server.tunnelOnly) && (
											<Badge size="xs" variant="light" color="orange">
												{i18n._("Tunnel")}
											</Badge>
										)}
									</Group>
								</Table.Td>
								<Table.Td visibleFrom="sm">
									<Text size="sm">
										{domain.service}:{domain.port}
										{domain.https ? "" : " (HTTP)"}
									</Text>
								</Table.Td>
								<Table.Td>
									<Group gap={4}>
										{Object.entries(domain.checks).map(([id, check]) => (
											<DomainCheckBadge
												key={id}
												status={check.status}
												label={domainCheckLabel(i18n, id)}
												detail={storedCheckText(i18n, check)}
											/>
										))}
										{Object.keys(domain.checks).length === 0 && (
											<Text size="xs" c="dimmed">
												{i18n._("Not checked")}
											</Text>
										)}
									</Group>
									{Object.keys(domain.checks).length > 0 && (
										<Text size="xs" c="dimmed" mt={4}>
											{Object.values(domain.checks)
												.map((check) => storedCheckText(i18n, check))
												.filter(Boolean)
												.join(" · ")}
										</Text>
									)}
								</Table.Td>
								<Table.Td>
									<Group gap={4} justify="flex-end" wrap="nowrap">
										{!domain.primary && can("domain.manage") && (
											<>
												<Tooltip label={i18n._("Make primary")}>
													<ActionIcon
														variant="subtle"
														aria-label={i18n._("Make primary")}
														onClick={() => makePrimary.mutate(domain.id)}
													>
														<Star size={14} />
													</ActionIcon>
												</Tooltip>
												<Tooltip label={i18n._("Remove")}>
													<ActionIcon
														variant="subtle"
														color="red"
														aria-label={i18n._("Remove")}
														loading={
															remove.isPending && remove.variables === domain.id
														}
														onClick={() => remove.mutate(domain.id)}
													>
														<Trash2 size={14} />
													</ActionIcon>
												</Tooltip>
											</>
										)}
									</Group>
								</Table.Td>
							</Table.Tr>
						))}
					</Table.Tbody>
				</Table>
			</Card>

			{limitation && (
				<Alert
					color="yellow"
					withCloseButton
					onClose={() => setLimitation(null)}
					title={i18n._("{host} is limited", { host: limitation.host })}
				>
					<Text size="sm">{errorText(i18n, limitation.info)}</Text>
				</Alert>
			)}
			{dnsWarning && (
				<Alert
					color="yellow"
					withCloseButton
					onClose={() => setDnsWarning(null)}
					title={i18n._("{host} does not point at this server yet", {
						host: dnsWarning.host,
					})}
				>
					<Text size="sm">
						{dnsWarning.text}{" "}
						{i18n._(
							"The domain was added; it works once the DNS record below is in place (DNS changes can take a while to spread).",
						)}
					</Text>
				</Alert>
			)}
			{records.length > 0 && (
				<Card withBorder p="md">
					<Title order={5} mb={4}>
						{i18n._("DNS records to create")}
					</Title>
					<Text size="xs" c="dimmed" mb="sm">
						{i18n._(
							"At your DNS provider, create these records (or check that they exist):",
						)}
					</Text>
					<Table.ScrollContainer minWidth={420}>
						<Table>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{i18n._("Type")}</Table.Th>
									<Table.Th>{i18n._("Name")}</Table.Th>
									<Table.Th>{i18n._("Value")}</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{records.map((record) => (
									<Table.Tr key={`${record.type}-${record.host}-${record.ip}`}>
										<Table.Td>
											<Code>{record.type}</Code>
										</Table.Td>
										<Table.Td>
											<Group gap={4} wrap="nowrap">
												<Code>{record.host}</Code>
												<CopyIconButton value={record.host} />
											</Group>
										</Table.Td>
										<Table.Td>
											<Group gap={4} wrap="nowrap">
												<Code>{record.ip}</Code>
												<CopyIconButton value={record.ip} />
											</Group>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</Table.ScrollContainer>
				</Card>
			)}
			<Card
				withBorder
				p="md"
				display={can("domain.manage") ? undefined : "none"}
			>
				<Title order={5} mb="sm">
					{i18n._("Add domain")}
				</Title>
				<form onSubmit={form.onSubmit((values) => add.mutate(values))}>
					<Group align="flex-end">
						<TextInput
							label={i18n._("Host")}
							placeholder={EXAMPLES.appHost}
							style={{ flex: 1, minWidth: 220 }}
							key={form.key("host")}
							{...form.getInputProps("host")}
							error={form.getInputProps("host").error ?? add.fieldError()}
							onChange={(event) => {
								add.clearFieldError();
								form.getInputProps("host").onChange(event);
							}}
						/>
						<Select
							label={i18n._("Service")}
							data={services}
							w={160}
							key={form.key("service")}
							{...form.getInputProps("service")}
						/>
						<NumberInput
							label={i18n._("Port")}
							min={1}
							max={65535}
							w={110}
							key={form.key("port")}
							{...form.getInputProps("port")}
						/>
						<Switch
							label="HTTPS"
							mb={8}
							key={form.key("https")}
							{...form.getInputProps("https", { type: "checkbox" })}
						/>
						{overview.server.tunnelEnabled && (
							<Switch
								label={i18n._("Via Cloudflare Tunnel")}
								mb={8}
								disabled={overview.server.tunnelOnly}
								key={form.key("viaTunnel")}
								{...form.getInputProps("viaTunnel", { type: "checkbox" })}
							/>
						)}
						<Button
							type="submit"
							leftSection={<Plus size={16} />}
							loading={add.isPending}
						>
							{i18n._("Add")}
						</Button>
					</Group>
				</form>
				{targetRule && (
					<Alert
						color={targetRule.policy === "refuse" ? "red" : "yellow"}
						mt="sm"
						title={
							targetRule.policy === "refuse"
								? i18n._("An additional domain is not supported on {target}", {
										target: `${targetRule.service}:${targetRule.port}`,
									})
								: i18n._("An additional domain on {target} is limited", {
										target: `${targetRule.service}:${targetRule.port}`,
									})
						}
					>
						<Text size="sm">
							{translateTemplateText(i18n, targetRule.reason)}
						</Text>
					</Alert>
				)}
				<Text size="xs" c="dimmed" mt="sm">
					{overview.server.tunnelEnabled
						? i18n._(
								"Tunnel domains: add the hostname to the tunnel in Cloudflare (service {service}); Cloudflare handles the certificate. Other domains: point an A/AAAA record at the server; Let's Encrypt issues the certificate on the first HTTPS request.",
								{ service: overview.server.tunnelService },
							)
						: overview.server.ips.length
							? i18n._(
									"Point an A record (or AAAA for IPv6) at {ips} first. The domain is checked right after you add it; Let's Encrypt issues the certificate on the first HTTPS request.",
									{ ips: formatList(i18n.locale, overview.server.ips, "unit") },
								)
							: i18n._(
									"Point an A/AAAA record at the server first. Let's Encrypt issues the certificate on the first HTTPS request.",
								)}
				</Text>
			</Card>
			<AppJobDrawer
				job={jobs.job}
				appName={app.name}
				onClose={jobs.closeJob}
				onCompleted={() => jobs.refresh()}
			/>
		</Stack>
	);
};
