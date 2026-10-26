---
name: zustand-store
description: >
  House pattern for Zustand client stores in Vex (apps/web/src/store).
  Use whenever adding or changing client-side global state: modals/sheets,
  UI preferences, composer drafts, upload queues, or a provider-neutral auth
  session snapshot. Covers the createXStore factory, grouped actions,
  useShallow selector hooks, SSR safety in TanStack Start, persist, and what
  must never live in a store (server data, money, permissions).
---

# Zustand stores (Vex)

Stores live in `apps/web/src/store/`, one file per store, named after the
domain: `composer.ts`, `ui-preferences.ts`, `auth-session.ts`. Import them
directly (no barrel), without file extensions:
`import { useComposerActions } from "#/store/composer"`.

Install once in `apps/web`: `bun add zustand`.

## What belongs in a store

Only client-owned UI state. Before creating a store, check this table:

| State | Where it lives |
| --- | --- |
| Balances, positions, risk limits, deployments, intents, pause status, policy | TanStack Query. Canonical server data; never copied into a store. |
| Chat messages, streaming parts, tool calls | TanStack AI `useChat` plus server persistence |
| Anything that should survive a shared link or back button (active chat, filters, locale) | Router params / search |
| Theme | Existing `ThemeProvider` (needs the pre-hydration script) |
| Open overlay, panel visibility, composer drafts, local upload progress, provider-neutral session snapshot | **Zustand** |

A store never authorizes anything. It must not hold secrets, tokens, signing
material, or a value the server treats as authority. A session snapshot only
mirrors what the auth adapter reports; the server still verifies every call.

## The pattern: state and actions are separate

Every store splits **state** (plain data) from **actions** (functions that
change it). Actions live under one `actions` key, so a component that only
dispatches subscribes to a stable reference and never re-renders when the
data changes.

Each store file has the same parts, in this order:

1. **State interface** `IX`: `readonly` data fields only, no functions.
2. **Initial state** `initXState: IX`.
3. **Actions interface** `IXActions`: `{ readonly actions: { ... } }`.
4. **Store type** `IXStore = IX & IXActions`.
5. **Factory** `createXStore(initState = initXState)` using vanilla
   `createStore` from `zustand`, so tests and per-request trees can create
   fresh instances.
6. **Instance**: a module singleton or a per-request provider (see SSR).
7. **Hooks**: `useX(selector)` for state via `useShallow`, and
   `useXActions()` for actions.

### Skeleton

Replace `X`/`x` with the store's domain name. The example is a composer
draft store (`src/store/composer.ts`) that keeps unsent text per
conversation.

```ts
import { createStore, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

// 1. State: data only.
export interface IComposer {
	readonly drafts: Readonly<Record<string, string>>;
}

// 2. Initial state.
export const initComposerState: IComposer = {
	drafts: {},
};

// 3. Actions: every mutator, grouped under `actions`.
export interface IComposerActions {
	readonly actions: {
		setDraft: (conversationId: string, text: string) => void;
		clearDraft: (conversationId: string) => void;
		reset: () => void;
	};
}

// 4. Store type.
export type IComposerStore = IComposer & IComposerActions;

// 5. Factory.
export const createComposerStore = (initState: IComposer = initComposerState) =>
	createStore<IComposerStore>()((set) => ({
		...initState,
		actions: {
			setDraft: (conversationId, text) =>
				set((state) => ({
					drafts: { ...state.drafts, [conversationId]: text },
				})),
			clearDraft: (conversationId) =>
				set((state) => {
					const { [conversationId]: _removed, ...drafts } = state.drafts;
					return { drafts };
				}),
			reset: () => set(initState),
		},
	}));

export type ComposerStore = ReturnType<typeof createComposerStore>;

// 6. Instance: written only by client interactions, so a singleton is safe.
export const composerStore = createComposerStore();

// 7. Hooks.
export const useComposer = <T>(selector: (state: IComposer) => T) =>
	useStore(composerStore, useShallow(selector));

export const useComposerActions = () =>
	useStore(
		composerStore,
		useShallow((state) => state.actions),
	);
```

Usage:

```tsx
// Reads one slice; re-renders only when this draft changes.
const draft = useComposer((s) => s.drafts[conversationId] ?? "");

// Dispatch only; never re-renders because of state changes.
const { setDraft, clearDraft } = useComposerActions();
setDraft(conversationId, event.target.value);
```

Rules for the pattern:

- `useX` selectors take `IX` (state), not the full store, so components
  cannot reach actions through the state hook.
- Select the smallest slice a component needs; return primitives or small
  objects (`useShallow` compares them shallowly).
- Actions are the only way to change state. Components never call
  `xStore.setState` directly.
- `reset` restores `initState`; add it to every store (tests, logout).
- Derived values are computed in the selector or component, not stored.

## SSR safety (TanStack Start)

Modules are evaluated once on the server and shared by every request.

- **Module singleton** (like `composerStore`) is allowed only when the store is
  written exclusively by client interactions and starts from a constant
  initial state. Never write to it during render, in a loader, or in
  `beforeLoad`.
- **Per-request/user data** (for example the auth session snapshot, or any
  store seeded from loader data) must not be a singleton. Create it per tree
  with a context provider:

```tsx
const AuthSessionContext = createContext<AuthSessionStore | null>(null);

export function AuthSessionProvider({
	initial,
	children,
}: {
	initial?: IAuthSession;
	children: React.ReactNode;
}) {
	const [store] = useState(() => createAuthSessionStore(initial));
	return <AuthSessionContext value={store}>{children}</AuthSessionContext>;
}

export const useAuthSession = <T,>(selector: (s: IAuthSessionStore) => T) => {
	const store = use(AuthSessionContext);
	if (!store) throw new Error("useAuthSession needs AuthSessionProvider");
	return useStore(store, useShallow(selector));
};
```

## Persisted stores

For preferences or drafts that should survive a reload, add `persist` with
`skipHydration` so the server HTML and the first client render match, then
rehydrate after mount:

```ts
import { createJSONStorage, persist } from "zustand/middleware";

export const createUiPreferencesStore = (initState = initUiPreferencesState) =>
	createStore<IUiPreferencesStore>()(
		persist(
			(set) => ({
				...initState,
				actions: {
					toggleRiskPanel: () =>
						set((s) => ({ riskPanelOpen: !s.riskPanelOpen })),
				},
			}),
			{
				name: "vex.ui-preferences",
				version: 1,
				storage: createJSONStorage(() => localStorage),
				skipHydration: true,
				partialize: ({ actions: _actions, ...state }) => state,
			},
		),
	);

// Once, in a client-only effect (e.g. in __root):
useEffect(() => {
	void uiPreferencesStore.persist.rehydrate();
}, []);
```

- Always `partialize` out `actions`.
- Bump `version` and add `migrate` when the persisted shape changes.
- Never persist anything from TanStack Query or anything sensitive.

## Provider-neutral stores

The app keeps vendors swappable (Privy ↔ Dynamic, etc.). A store that mirrors
a vendor SDK stores neutral fields only (`status`, `userId`, `walletAddress`,
`provider`), never SDK objects or vendor-named fields. The vendor adapter
writes into the store; components read the store and never import the SDK.

## Checklist

- [ ] The state is client-only UI state (table above); it is not server data,
      money, or permission.
- [ ] File in `apps/web/src/store/<name>.ts`, extensionless imports.
- [ ] State (`IX`) and actions (`IXActions`) are separate interfaces;
      `initXState`, `createXStore`, `useX`, `useXActions` all present.
- [ ] Mutators grouped under `actions`; components use `useXActions()` to
      dispatch and never call `setState` directly.
- [ ] Selectors go through `useShallow`; select the smallest slice needed.
- [ ] Singleton only if client-interaction-only; otherwise context provider.
- [ ] Persisted stores use `skipHydration`, `partialize`, and `version`.
