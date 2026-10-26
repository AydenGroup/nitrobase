import { useLingui } from "@lingui/react";
import {
	Alert,
	Avatar,
	Badge,
	Button,
	Card,
	Chip,
	Code,
	Group,
	MultiSelect,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Rocket, Search, Store, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { localizedTemplate } from "#/components/templates/localized.ts";
import {
	TemplateBadges,
	TemplateLimitation,
	TemplateLinks,
	useCategoryLabel,
} from "#/components/templates/TemplateMeta";
import { EmptyState } from "#/components/ui/EmptyState";
import { PageHeader } from "#/components/ui/PageHeader";
import {
	type AppSourceDefinition,
	type AppSourceKind,
	appSources,
} from "#/config/app-sources.ts";
import {
	templateProblemsQueryOptions,
	templatesQueryOptions,
} from "#/features/templates/templates.query.ts";
import { errorDetail, errorText } from "#/libs/coded.ts";
import { LocalizedLink, translateTemplateText } from "#/libs/i18n.ts";
import { formatBytes } from "#/libs/intl.ts";

/** Create page of kinds with their own section (databases), else null. */
function sectionOf(kind: AppSourceKind): string | null {
	return (appSources[kind] as AppSourceDefinition).section?.create ?? null;
}

export const Route = createFileRoute("/{-$locale}/_authed/marketplace/")({
	loader: async ({ context }) => {
		await context.queryClient.query(templatesQueryOptions);
		return { crumb: context.i18n._("Marketplace") };
	},
	component: Marketplace,
});

function Marketplace() {
	const { i18n } = useLingui();
	const { data: templates = [] } = useQuery(templatesQueryOptions);
	const can = useCan();
	// Load errors are for template authors: instance administrators.
	const { data: problems = [] } = useQuery({
		...templateProblemsQueryOptions,
		enabled: can("instance.manage"),
	});
	const categoryLabel = useCategoryLabel();
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState("all");
	const [tags, setTags] = useState<string[]>([]);
	const categories = useMemo(
		() => [...new Set(templates.map((template) => template.category))].sort(),
		[templates],
	);
	const allTags = useMemo(
		() => [...new Set(templates.flatMap((template) => template.tags))].sort(),
		[templates],
	);
	// Tags are template texts (extracted for translation).
	const tagLabel = (tag: string) => translateTemplateText(i18n, tag) ?? tag;
	const filtered = templates.filter((template) => {
		const query = search.trim().toLowerCase();
		const texts = localizedTemplate(template, i18n);
		const text = [
			template.name,
			texts.name,
			template.description,
			texts.description,
			categoryLabel(template.category),
			...template.tags,
			...template.tags.map(tagLabel),
		]
			.join(" ")
			.toLowerCase();
		return (
			(category === "all" || template.category === category) &&
			tags.every((tag) => template.tags.includes(tag)) &&
			(!query || text.includes(query))
		);
	});

	return (
		<Stack gap="lg">
			<PageHeader
				title={i18n._("Marketplace")}
				description={i18n._("Deploy an app from a template")}
			/>
			<Group gap="sm" wrap="wrap">
				<TextInput
					leftSection={<Search size={16} />}
					placeholder={i18n._("Search templates")}
					value={search}
					onChange={(event) => setSearch(event.currentTarget.value)}
					w={{ base: "100%", sm: 280 }}
				/>
				<Chip.Group
					value={category}
					onChange={(value) => setCategory(value as string)}
				>
					<Group gap={6}>
						<Chip value="all" size="sm">
							{i18n._("All")}
						</Chip>
						{categories.map((item) => (
							<Chip key={item} value={item} size="sm">
								{categoryLabel(item)}
							</Chip>
						))}
					</Group>
				</Chip.Group>
				<MultiSelect
					data={allTags.map((tag) => ({ value: tag, label: tagLabel(tag) }))}
					value={tags}
					onChange={setTags}
					placeholder={i18n._("Filter by tags")}
					aria-label={i18n._("Filter by tags")}
					clearable
					searchable
					w={{ base: "100%", sm: 260 }}
				/>
			</Group>
			{problems.length > 0 && (
				<Stack gap="sm">
					{problems.map((problem) => (
						<Alert
							key={problem.folder}
							color="red"
							icon={<TriangleAlert size={16} />}
							title={i18n._("Template could not be loaded: {folder}", {
								folder: problem.folder,
							})}
						>
							<Text size="sm" mb="xs">
								{i18n._(
									"Fix templates/{folder}/template.toml; the template stays hidden until it validates. Only administrators see this.",
									{ folder: problem.folder },
								)}
							</Text>
							<Text size="sm" mb="xs">
								{errorText(i18n, problem.error)}
							</Text>
							{errorDetail(problem.error) && (
								<Code block>{errorDetail(problem.error)}</Code>
							)}
						</Alert>
					))}
				</Stack>
			)}
			{filtered.length === 0 ? (
				<EmptyState
					icon={Store}
					title={i18n._("No templates found")}
					description={i18n._("Try another search or category.")}
				/>
			) : (
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
					{filtered.map((template) => {
						const texts = localizedTemplate(template, i18n);
						return (
							<Card
								key={template.id}
								p="md"
								style={{ display: "flex", flexDirection: "column" }}
							>
								<Group
									justify="space-between"
									mb="xs"
									wrap="nowrap"
									align="flex-start"
								>
									<Group gap="sm" wrap="nowrap">
										<Avatar
											src={
												template.hasLogo
													? `/api/templates/${template.id}/logo`
													: undefined
											}
											radius="md"
										>
											{texts.name.slice(0, 2)}
										</Avatar>
										<div>
											<Text fw={600}>{texts.name}</Text>
											{template.repo && (
												<Text size="xs" c="dimmed">
													{template.repo}
												</Text>
											)}
										</div>
									</Group>
									<TemplateLinks template={template} />
								</Group>
								<TemplateBadges template={template} />
								<TemplateLimitation template={template} />
								<Text size="sm" c="dimmed" my="sm" style={{ flex: 1 }}>
									{texts.description}
								</Text>
								<Group gap={4} mb="xs">
									{template.tags
										// The category chip already says it.
										.filter((tag) => tag !== template.category)
										.slice(0, 5)
										.map((tag) => (
											<Badge
												key={tag}
												size="xs"
												variant="outline"
												color="gray"
												style={{ cursor: "pointer" }}
												onClick={() =>
													setTags((prev) =>
														prev.includes(tag) ? prev : [...prev, tag],
													)
												}
											>
												{tagLabel(tag)}
											</Badge>
										))}
								</Group>
								<Text size="xs" c="dimmed" mb="md">
									{[
										template.requirements.memoryMb
											? i18n._("{memory} RAM", {
													memory: formatBytes(
														i18n.locale,
														template.requirements.memoryMb * 1024 * 1024,
													),
												})
											: null,
										template.minDockerVersion
											? i18n._("Docker {version}+", {
													version: template.minDockerVersion,
												})
											: null,
									]
										.filter(Boolean)
										.join(" · ")}
								</Text>
								<Button
									display={can("app.deploy") ? undefined : "none"}
									component={LocalizedLink}
									{...(sectionOf(template.sourceKind)
										? { to: sectionOf(template.sourceKind) as string }
										: {
												to: "/apps/new",
												search: { template: template.id },
											})}
									leftSection={<Rocket size={16} />}
									variant={template.advanced ? "light" : "filled"}
								>
									{i18n._("Deploy")}
								</Button>
							</Card>
						);
					})}
				</SimpleGrid>
			)}
		</Stack>
	);
}
