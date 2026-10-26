---
name: i18n-lingui
description: >
  House rules for translating Vex's web UI with Lingui on TanStack Start
  (apps/web). Use whenever writing or changing any user-visible text: React
  components, labels helpers, error messages, route titles, aria-labels,
  numbers/currency/dates, locale-aware links, or when adding a language or
  updating the en/es catalogs.
---

# i18n with Lingui (Vex)

Setup already in place, do not re-create it:

- `apps/web/src/lib/i18n.ts`: `createLinguiStart` config, exports `locales`,
  `defaultLocale` (`"en"`), `Locale`, `useLocale`, `LocalizedLink`,
  `localizePath`, `isValidLocale`, `setupI18n`, `routerWithI18n`.
- `routerWithI18n` wraps the router in `I18nProvider`, so `useLingui()` works
  in every route component, including `errorComponent` and
  `notFoundComponent`.
- Routes live under `src/routes/{-$locale}/`. English has no prefix (`/`),
  other locales are prefixed (`/es`). The `{-$locale}` layout rejects unknown
  locales with `notFound()`.
- Catalogs: `src/locales/en.json` (source) and `src/locales/es.json`, minimal
  JSON format, message ID = the English source text.

## Rule 1: every visible string goes through `i18n._()`

In components, always:

```tsx
import { useLingui } from "@lingui/react";

export function NotFound() {
	const { i18n } = useLingui();
	return <EmptyTitle>{i18n._("Page not found")}</EmptyTitle>;
}
```

This covers text nodes, `placeholder`, `title`, `aria-label`, `sr-only`
spans, tooltip content, toast text, and dialog titles/descriptions.

Do not use the `t` macro or `<Trans>`, and do not call `msg` inside a
component body. The project convention is `useLingui()` from `@lingui/react`
plus `i18n._(...)`, where the argument is either a string literal (Rule 2) or
a module-level `msg` descriptor (Rule 3).

## Rule 2: the argument is a string literal

The extractor only sees literals. The first argument must be the full English
sentence written inline.

```tsx
// Correct
i18n._("Updated {seconds}s ago", { seconds: quote.observedSecondsAgo });
i18n._("Run {name}", { name: deployment.name });

// Wrong: not extractable
i18n._(`Updated ${seconds}s ago`);
i18n._(label);
i18n._("Updated " + seconds + "s ago");
```

- Interpolate with `{name}` placeholders and a values object.
- Keep whole sentences in one message; never concatenate translated
  fragments, because word order differs between languages.
- Punctuation and ellipses (`…`) belong inside the message.

## Rule 3: labels declared outside components use `msg`

Any label that is known at module level (enum/status maps, nav items,
suggestion lists, menu definitions) is declared once, outside the component,
as a `msg` descriptor, and rendered with `i18n._(descriptor)`:

```ts
// src/components/chat/lib/labels.ts
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export const intentStatusLabels = {
	proposed: msg({ id: "Proposed" }),
	policy_blocked: msg({ id: "Policy blocked" }),
	// ...one entry per status
} satisfies Record<TradeIntentStatus, MessageDescriptor>;
```

```tsx
const { i18n } = useLingui();
<Badge>{i18n._(intentStatusLabels[intent.status])}</Badge>
```

- Key the map by the domain type with `satisfies Record<Union, MessageDescriptor>`
  so a new enum value without a label is a compile error (see
  `blockReasonLabels`, keyed by `PolicyBlockReason` from `@vex/policy`).
- Static lists put the descriptor in the item and translate at render time;
  use a stable non-translated `id`/`key` for React keys:

```ts
const items = [
	{ id: "strategies", label: msg({ id: "Strategies" }), icon: LayersIcon },
	{ id: "portfolio", label: msg({ id: "Portfolio" }), icon: WalletIcon },
];
// render: <span>{i18n._(item.label)}</span>
```

- Shared domain label maps live in the feature's `lib/labels.ts`; a list used
  by one component stays at the top of that component's file.
- `msg({ id: "..." })` takes a literal, same as Rule 2. Never build IDs
  dynamically. Error codes follow the same pattern (Rule 4).

## Rule 4: errors use message descriptors

Typed application errors are declared once with `msg` in
`src/lib/error-codes.ts`, thrown as `AppError`, and rendered with
`getAppErrorMessage(i18n, error)` from `src/lib/error.ts`:

```ts
export const errorCodes = {
	AUTH_USER_NOT_FOUND: msg({ id: "User not found" }),
} satisfies Record<string, MessageDescriptor>;
```

Unknown errors show a generic translated message; raw `error.message` is only
shown in development (see `RouteError`).

## Rule 5: numbers, money, percent, dates

Lingui's `i18n.number` and `i18n.date` are deprecated. Use the helpers in
`src/lib/intl.ts`, which wrap `Intl.NumberFormat` / `Intl.DateTimeFormat` with
the active locale and cache formatters:

```tsx
import { formatCurrency, formatDate, formatNumber, formatPercent } from "#/lib/intl";

const { i18n } = useLingui();
formatCurrency(i18n.locale, price);                                  // $3,412.55 · 3412,55 US$
formatCurrency(i18n.locale, liquidity, { notation: "compact" });     // $48M
formatPercent(i18n.locale, pct / 100, { maximumFractionDigits: 2 }); // ratio in, "2.4%" out
formatPercent(i18n.locale, change / 100, { signDisplay: "always" }); // +2.4%
formatNumber(i18n.locale, count);
formatDate(i18n.locale, timestamp, { dateStyle: "medium", timeStyle: "short" });
```

- `formatPercent` takes a ratio (0.024), exactly like `Intl` percent style.
- `formatCurrency` defaults to USD; pass `{ currency }` for others.
- Never call `i18n.number` / `i18n.date`, and never hand-build strings like
  `` `$${n.toFixed(2)}` ``.
- `Intl` output contains non-breaking spaces (U+00A0), e.g. `4,20 US$`; do
  not compare formatted strings with plain spaces in tests.

Canonical decimal strings from the server (amounts, hashes, addresses) are
shown verbatim when precision matters; do not round them through `Number`.

## Rule 6: what is not translated

- User-written and model-generated content (chat messages, strategy names the
  user typed, document titles).
- Identifiers and canonical data: tool IDs (`market.getPrice`), pairs
  (`WETH/USDC`), venues, chain names, addresses, intent hashes.
- Brand name `Vex`.

## Rule 7: route titles and non-component code

Route `head` runs outside React; use the router context:

```ts
head: ({ match }) => ({
	meta: [{ title: `Vex · ${match.context.i18n._("Chat")}` }],
}),
```

Server functions and other non-React code receive an `I18n` instance as a
parameter; never import a global one.

## Rule 8: locale-aware navigation

- Internal links use `LocalizedLink` (same props as `Link`, `to` without the
  locale prefix): `<LocalizedLink to="/">`.
- For "go home" style links on pages that may be reached with an invalid
  locale segment, pass the current locale explicitly with
  `useHomeParams()` from `#/hooks/use-home-params`:
  `<LocalizedLink to="/" params={homeParams}>`.
- Switch language with `useLocale().switchLocale(code)`; list options from
  `locales` (`nativeName` is already in the target language, do not
  translate it).
- `Button asChild` + `LocalizedLink` for button-styled links.

## Rule 9: third-party and shadcn components

Generated components in `components/ui` can contain hardcoded English (for
example `MessageScrollerButton` "Scroll to end", the viewport's
`aria-label="Messages"`, the sidebar's mobile sheet title). Override them from
the call site with translated `children`/`aria-label`:

```tsx
<MessageScrollerViewport aria-label={i18n._("Messages")}>
<MessageScrollerButton>
	<ArrowDownIcon />
	<span className="sr-only">{i18n._("Scroll to latest")}</span>
</MessageScrollerButton>
```

## Workflow after changing text

From `apps/web`:

1. `bun run i18n:extract`: adds new IDs to both catalogs and removes unused
   ones (`--clean`). Its table shows the "Missing" count per locale.
2. Fill every new key in `src/locales/es.json`. An empty value means
   untranslated; the UI falls back to the English source.
3. Check in the browser at `/es/...`: text, number formats (`4,20 US$`,
   `1,1 %`), and layout with longer Spanish strings.

Do not edit IDs in `es.json` by hand; change the English literal in code and
re-extract. Changing an English string creates a new ID, so its translation
must be redone.

## Adding a language

1. Add the code to `locales` in `lingui.config.ts`.
2. Add `{ code, name, nativeName }` to `locales` in `src/lib/i18n.ts`.
3. Run `bun run i18n:extract`, then translate the new
   `src/locales/<code>.json`.

## Checklist

- [ ] No hardcoded visible string, placeholder, or aria-label in the diff.
- [ ] Every `i18n._()` argument is a complete English literal or a
      module-level `msg` descriptor; label maps use `satisfies Record<...>`.
- [ ] Placeholders instead of concatenation; one sentence per message.
- [ ] Numbers/money/percent/dates go through `#/lib/intl` helpers (not the
      deprecated `i18n.number`/`i18n.date`).
- [ ] Links use `LocalizedLink`.
- [ ] `bun run i18n:extract` run and `es.json` has no new empty values.
