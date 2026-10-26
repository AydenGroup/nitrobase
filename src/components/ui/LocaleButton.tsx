import { useLingui } from "@lingui/react";
import { ActionIcon, Avatar, Menu } from "@mantine/core";
import { CheckIcon, EarthIcon } from "lucide-react";
import { locales, useLocale } from "#/libs/i18n.ts";

/**
 * Language menu. `switchLocale` stores the choice in the locale cookie,
 * loads the catalog and navigates to the locale-prefixed URL.
 * Each language is listed by its own name (endonym), so a reader can find
 * theirs whatever the current locale. Flags are served from
 * `public/flags/<code>.svg`.
 */
export const LocaleButton: React.FC = () => {
	const { i18n } = useLingui();
	const { currentLocale, switchLocale } = useLocale();

	return (
		<Menu offset={16} position="bottom-end" width={180}>
			<Menu.Target>
				<ActionIcon
					variant="subtle"
					color="gray"
					radius="100%"
					aria-label={i18n._("Change language")}
				>
					<EarthIcon size={22} strokeWidth={1} />
				</ActionIcon>
			</Menu.Target>

			<Menu.Dropdown>
				{locales.map((lang) => (
					<Menu.Item
						key={lang.code}
						px={10}
						lang={lang.code}
						aria-current={currentLocale === lang.code ? "true" : undefined}
						onClick={() => switchLocale(lang.code)}
						leftSection={
							<Avatar size={16} src={`/flags/${lang.code}.svg`} alt="" />
						}
						rightSection={
							currentLocale === lang.code ? (
								<CheckIcon size={18} aria-hidden />
							) : null
						}
					>
						{lang.nativeName}
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
};
