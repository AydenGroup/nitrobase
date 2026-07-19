import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { AnyRouter } from "@tanstack/react-router";
import { Fragment, type PropsWithChildren, type ReactNode } from "react";

type AdditionalOptions = {
	WrapProvider?: (props: { children: ReactNode }) => React.JSX.Element;
};

export type ValidateRouter<TRouter extends AnyRouter> =
	NonNullable<TRouter["options"]["context"]> extends {
		i18n: I18n;
	}
		? TRouter
		: never;

export function routerWithI18n<TRouter extends AnyRouter>(
	router: ValidateRouter<TRouter>,
	i18n: I18n,
	additionalOpts?: AdditionalOptions,
): TRouter {
	const ogOptions = router.options;

	router.options = {
		...router.options,
		context: {
			...ogOptions.context,
			i18n,
		},

		Wrap: ({ children }: PropsWithChildren) => {
			const OuterWrapper = additionalOpts?.WrapProvider || Fragment;
			const OGWrap = ogOptions.Wrap || Fragment;

			return (
				<OuterWrapper>
					<I18nProvider i18n={i18n}>
						<OGWrap>{children}</OGWrap>
					</I18nProvider>
				</OuterWrapper>
			);
		},
	};

	if (router.isServer) {
		router.options.dehydrate = async () => {
			const ogDehydrated = (await ogOptions.dehydrate?.()) ?? {};

			return {
				...ogDehydrated,
				dehydratedI18n: {
					locale: i18n.locale,
					messages: i18n.messages,
				},
			};
		};
	} else {
		router.options.hydrate = async (dehydrated) => {
			await ogOptions.hydrate?.(dehydrated);
			const dehydratedI18n = dehydrated?.dehydratedI18n;

			if (!dehydratedI18n) {
				return;
			}

			i18n.loadAndActivate({
				locale: dehydratedI18n.locale,
				messages: dehydratedI18n.messages,
			});
		};
	}

	return router;
}
