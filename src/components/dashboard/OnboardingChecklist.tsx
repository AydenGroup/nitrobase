import { useLingui } from "@lingui/react";
import {
	Anchor,
	Button,
	CloseButton,
	Group,
	Progress,
	Stack,
	Text,
	ThemeIcon,
} from "@mantine/core";
import { CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useCan } from "#/components/teams/useCan";
import { SectionCard } from "#/components/ui/SectionCard";
import { storageKey } from "#/config/identifiers.ts";
import { type OnboardingStepId, onboardingSteps } from "#/config/onboarding.ts";
import { APP_NAME } from "#/config/shared.ts";
import { LocalizedLink } from "#/libs/i18n.ts";

const DISMISS_KEY = storageKey("onboarding.dismissed");

function readDismissed(): boolean {
	try {
		return window.localStorage.getItem(DISMISS_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * Getting-started checklist (registry `#/config/onboarding.ts`), built from
 * real state. Hidden once every visible step is done; dismissible (per
 * browser).
 */
export const OnboardingChecklist: React.FC<{
	done: Record<OnboardingStepId, boolean>;
	/** "Install on a VPS" guide (installer docs). */
	installGuideUrl?: string;
}> = ({ done, installGuideUrl }) => {
	const { i18n } = useLingui();
	const can = useCan();
	// Read after mount: SSR has no localStorage.
	const [dismissed, setDismissed] = useState(true);
	useEffect(() => setDismissed(readDismissed()), []);

	const steps = onboardingSteps.filter(
		(step) => !step.permission || can(step.permission),
	);
	const completed = steps.filter((step) => done[step.id]).length;
	if (dismissed || steps.length === 0 || completed === steps.length) {
		return null;
	}
	const dismiss = () => {
		setDismissed(true);
		try {
			window.localStorage.setItem(DISMISS_KEY, "1");
		} catch {
			// Not persisted (private mode): hidden for this visit only.
		}
	};

	return (
		<SectionCard
			title={i18n._("Getting started")}
			description={i18n._("{done} of {total} done", {
				done: completed,
				total: steps.length,
			})}
			actions={
				<CloseButton
					aria-label={i18n._("Hide the getting started checklist")}
					onClick={dismiss}
				/>
			}
		>
			<Stack gap="sm">
				<Progress
					value={(completed / steps.length) * 100}
					size="sm"
					aria-label={i18n._("Getting started progress")}
				/>
				{steps.map((step) => {
					const isDone = done[step.id];
					return (
						<Group key={step.id} wrap="nowrap" align="flex-start" gap="sm">
							<ThemeIcon
								variant="light"
								color={isDone ? "green" : "gray"}
								radius="xl"
								size="md"
							>
								{isDone ? <CircleCheck size={16} /> : <step.icon size={16} />}
							</ThemeIcon>
							<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
								<Text
									size="sm"
									fw={500}
									td={isDone ? "line-through" : undefined}
									c={isDone ? "dimmed" : undefined}
								>
									{i18n._(step.label)}
								</Text>
								{!isDone && (
									<Text size="xs" c="dimmed">
										{i18n._(step.description)}
									</Text>
								)}
							</Stack>
							{!isDone && (
								<Button
									component={LocalizedLink}
									to={step.to}
									search={step.search}
									size="xs"
									variant="light"
								>
									{i18n._(step.action)}
								</Button>
							)}
						</Group>
					);
				})}
				<Group justify="space-between">
					{installGuideUrl ? (
						<Anchor
							size="xs"
							href={installGuideUrl}
							target="_blank"
							rel="noreferrer"
						>
							{i18n._("Install {appName} on a VPS", { appName: APP_NAME })}
						</Anchor>
					) : (
						<span />
					)}
					<Anchor size="xs" c="dimmed" onClick={dismiss} component="button">
						{i18n._("I know my way around, hide this")}
					</Anchor>
				</Group>
			</Stack>
		</SectionCard>
	);
};
