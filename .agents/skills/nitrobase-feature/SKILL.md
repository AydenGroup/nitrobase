---
name: nitrobase-feature
description: "Create or extend Nitrobase features, pages, forms, UI components, and server functions. Use when adding code under src/features, src/components, or src/components/ui, or integrating Mantine, Lingui i18n, TanStack React Start server functions, and Zod schemas using existing project conventions."
---

# Nitrobase Feature

Create code by following the closest existing convention. Do not add abstractions or directories that current requirements do not need.

## Before editing

1. Read the most similar existing feature, component, and route.
2. Reuse existing components, helpers, schemas, middleware, and dependencies.
3. Preserve the `#/` import alias and current TypeScript conventions.
4. Create only files required by the request.

## File placement

Choose directories by responsibility:

```text
src/
  components/
    ui/                  # Shared UI without feature business logic
    <feature>/           # Feature forms and presentation components
  features/
    <feature>/
      <feature>.functions.ts
      <feature>.server.ts
      <feature>.query.ts # Create only when reusable React Query options are needed
      schema.ts
  routes/                # Thin routes: load data and compose layouts/components
```

- Put feature-specific components in `src/components/<feature>/`.
- Put shared, business-agnostic components in `src/components/ui/`.
- Put business logic and data access in `src/features/<feature>/`.
- Never put DB queries, hashing, session mutations, or secrets in components or routes.
- Do not create barrel `index.ts` files unless current code needs them.

## Mantine

Use Mantine as the primary UI library.

- Prefer components from `@mantine/core` over custom HTML.
- Use `@mantine/form` for forms and `schemaResolver` for Zod validation.
- Use the existing notification wrapper at `src/components/ui/Notifications.tsx`.
- Reuse existing theme, spacing, color, responsive props, and components.
- Add custom CSS only when Mantine props or theme cannot meet the requirement.
- Preserve accessibility: input labels, loading and disabled states, keyboard interaction, and semantic controls.

Review these references first:

- `src/components/auth/LoginForm.tsx`
- `src/components/auth/RegisterForm.tsx`
- `src/components/auth/ProfileForm.tsx`
- `src/components/ui/`

## i18n

All user-facing text and validation messages must use Lingui.

- In React components, use `const { i18n } = useLingui()` from `@lingui/react` and `i18n._("Message")`.
- In Zod schemas, accept `I18n` from `@lingui/core`, following `LoginSchema(i18n)` in `src/features/auth/schema.ts`.
- In server functions requiring locale context, use `i18nMiddleware` and read `context.i18n`.
- Never hardcode user-facing text in one language.
- Use English as message IDs and source text, matching current catalogs.
- After adding or changing messages, run project i18n extract and compile scripts when catalogs need updates.

Review these references first:

- `src/libs/i18n.ts`
- `src/features/auth/schema.ts`
- `src/components/ui/AppVersion.tsx`
- `src/locales/en.json`
- `src/locales/vi.json`

## Server code separation

Structure each server-side feature after `src/features/auth`.

### `<feature>.server.ts`

- Contains DB queries, mutations, and server-only business logic.
- Imports `db`, Drizzle schemas, and server-only dependencies here.
- Validates business invariants and throws `AppError` with suitable error codes.
- Never expose this module directly to React components.

### `<feature>.functions.ts`

- Contains public server functions created with `createServerFn` from `@tanstack/react-start`.
- Uses the correct HTTP method.
- Attaches required middleware, including `i18nMiddleware` or auth middleware.
- Validates input at the trust boundary with schemas from `schema.ts`.
- Calls business logic from `<feature>.server.ts`; never duplicates DB logic.

### `schema.ts`

- Contains Zod schemas and types inferred from schemas.
- Uses `i18n` for validation messages.
- Reuses the same schema for Mantine forms and server validation when appropriate.
- Contains no DB access or React UI.

### `<feature>.query.ts`

- Create only when clients need reusable `queryOptions`.
- Keep query keys stable and feature-scoped.
- Query functions call `<feature>.functions.ts`, never `<feature>.server.ts`.

## Dependency flow

Keep dependencies one-way:

```text
route -> component -> functions -> server -> db
                   -> schema  <- functions
```

- Routes never import `.server.ts`.
- Components never import `.server.ts`.
- `.server.ts` never imports React components.
- Avoid circular imports.

## Feature creation workflow

1. Identify required routes and components.
2. Create `src/features/<feature>/schema.ts` when input exists.
3. Create `<feature>.server.ts` for DB access and server business logic.
4. Create `<feature>.functions.ts` for boundaries, middleware, and validation.
5. Create `<feature>.query.ts` only when multiple callers need shared query options.
6. Put shared UI in `src/components/ui/` and feature UI in `src/components/<feature>/`.
7. Keep routes thin: compose loaders, components, and navigation only.
8. Update message catalogs.
9. Run relevant typecheck, lint/check, and tests.

## Completion checklist

- Mantine replaces custom HTML or CSS where a suitable component exists.
- No untranslated user-facing strings remain.
- Zod validates server input.
- DB code exists only in the server layer.
- Auth-required functions use existing auth middleware.
- Imports follow current aliases and conventions.
- No unrequested files, abstractions, or dependencies were added.
- Project typecheck and checks pass.
