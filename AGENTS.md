# AGENTS.md

## Purpose
- Repository-level operating guide for coding agents working in this project.
- Follow this file unless a direct user request conflicts with it.
- Keep edits minimal, typed, and consistent with existing local conventions.

## Project Snapshot
- Monorepo-style layout with two TypeScript apps:
- Plugin app: Create Figma Plugin (`apps/figma-plugin/src/main.ts`, `apps/figma-plugin/src/ui.ts`).
- `apps/web/` backend: Next.js app hosting AI proxy endpoints.
- Node target: `v22` (from root `README.md`).
- Package manager and scripts: Bun with Turborepo workspaces.

## Repository Layout
- `apps/figma-plugin/src/main.ts`: Figma main thread entrypoint and adaptation orchestration.
- `apps/figma-plugin/src/ui.ts`: plugin iframe UI and typed message send/receive.
- `apps/figma-plugin/src/messages.ts`: source of truth for main<->ui message contracts.
- `apps/figma-plugin/src/adaptation-*.ts`: frame analysis, plan schema, and apply logic.
- `apps/figma-plugin/src/placement.ts` + `apps/figma-plugin/src/placement-geometry.ts`: deterministic placement helpers.
- `apps/web/app/api/resize/route.ts`: initial layout generation endpoint.
- `apps/web/app/api/refine/route.ts`: refinement pass endpoint.
- `apps/web/app/api/screenshots/upload/route.ts`: screenshot upload endpoint.
- Generated artifacts: `apps/figma-plugin/build/`, `apps/figma-plugin/manifest.json`, and `apps/web/.next/` (do not hand-edit).

## Install and Run Commands
- Root dependencies: `bun install`
- Plugin build (typecheck + bundle + minify): `bun run build:plugin`
- Plugin watch mode: `bun run watch`
- Web dev server: `bun run dev:web`
- Web production build: `bun run build:web`
- Web start production server: `bun run --cwd apps/web start`

## Lint, Typecheck, and Test Commands
- Root plugin has no dedicated `lint` script.
- Root plugin has no dedicated `test` script.
- Root type safety currently runs through `bun run build:plugin`.
- Web lint command exists: `bun run lint:web`
- Web currently has no `test` script.
- Do not claim lint/test passed unless that exact command was run successfully.

## Single Test Guidance (Important)
- There is no configured test runner in root or `apps/web/` right now.
- Single-test execution is therefore not available in current repo state.
- If asked to run one test, state tests are not configured yet.
- If you introduce tests, add scripts and document exact single-test command here.
- Suggested future convention (Vitest): `bun run test -- path/to/file.test.ts -t "case name"`

## Important Command Caveats
- Avoid raw `bunx tsc --noEmit` in root (plugin typings can conflict on globals).
- Prefer `bun run build:plugin` for reliable plugin typecheck behavior.
- Rebuild plugin before handoff when touching message contracts or placement logic.
- For backend-only changes, run at least `bun run lint:web`.

## Source of Truth Rules
- Treat `apps/figma-plugin/src/messages.ts` as canonical for plugin message payload schemas.
- Update sender and receiver paths in a single change when message shapes change.
- Keep discriminated unions exhaustive in message handlers.
- Keep adaptation output schema aligned with `apps/figma-plugin/src/adaptation-plan-schema.ts`.

## Coding Style: Imports
- Use ES module imports.
- Plugin files (`apps/figma-plugin/src/`): prefer single quotes and no semicolons.
- Web files (`apps/web/`): preserve existing local style in each file (some use semicolons/double quotes).
- Order imports: external first, blank line, then local imports.
- Use type-only imports for types (`import type { ... }`).

## Coding Style: Formatting
- Use 2-space indentation.
- Prefer guard clauses and early returns over nested branches.
- Keep functions focused; extract helpers for non-trivial repeated logic.
- Preserve existing punctuation style per touched file; avoid repo-wide reformat churn.
- Keep user-facing text concise and action-oriented.

## Coding Style: Types
- Keep strict TypeScript compatibility.
- Type parameters and return types explicitly on exported/public functions.
- Prefer precise unions and type guards over `any`.
- Preserve literal unions for message `type`, stage, and preset values.
- Validate unknown external input before narrowing and use.

## Naming Conventions
- `PascalCase` for types and interfaces.
- `camelCase` for variables, functions, and parameters.
- `UPPER_SNAKE_CASE` for module-level constants.
- Kebab-case for multiword filenames in `apps/figma-plugin/src/`.
- Keep message type strings explicit and stable (for example `'SELECTION_STATE'`).

## Validation and Control Flow
- Validate UI and API payloads at boundaries before mutation logic.
- Re-check Figma selection state immediately before document changes.
- Handle `undefined` lookup misses explicitly.
- Prefer deterministic operations in placement/layout helpers.
- Keep geometry helpers pure and side-effect free.

## Error Handling Guidelines
- Wrap mutation-heavy plugin operations in `try/catch` when failure is possible.
- Use `figma.notify(...)` for actionable plugin failures.
- In backend routes, return structured JSON errors with stable error codes.
- Include request metadata (`requestId`, `durationMs`) in backend responses.
- Use `_error` for intentionally unused caught errors.
- Do not silently swallow errors that affect user flow.

## Figma Plugin Boundaries
- `apps/figma-plugin/src/main.ts` owns document reads/writes and viewport/selection updates.
- `apps/figma-plugin/src/ui.ts` owns DOM rendering and posts typed `pluginMessage` payloads.
- Do not move UI DOM logic into main thread code.
- After mutation, keep viewport/selection coherent (`scrollAndZoomIntoView`).
- Avoid partial state updates when adaptation/apply fails.

## Next.js Backend Notes
- Follow `apps/web/AGENTS.md` for web-specific rules.
- Current `apps/web/AGENTS.md` rule: Next.js version has breaking changes; check docs in `node_modules/next/dist/docs/` when needed.
- Keep API handlers deterministic and schema-driven.
- Preserve CORS behavior for plugin-to-local-backend calls.

## Cursor and Copilot Rules Scan
- No `.cursor/rules/` directory found at repository root.
- No `.cursorrules` file found at repository root.
- No `.github/copilot-instructions.md` file found at repository root.
- If any are added later, mirror key instructions in this file.

## Generated Files and Artifacts
- Do not manually edit `apps/figma-plugin/build/main.js` or `apps/figma-plugin/build/ui.js`.
- Do not manually maintain generated `apps/figma-plugin/manifest.json`.
- Do not manually edit `apps/web/.next/**` outputs.
- Change source files, then rebuild the relevant package.

## Agent Checklist Before Handoff
- Keep changes localized and avoid unrelated refactors.
- Verify message/type contract changes end-to-end.
- Run relevant validation commands for touched areas.
- Report which commands were run and whether they passed.
- If a command is unavailable, state that explicitly.

## Anti-Patterns to Avoid
- Untyped ad-hoc message payloads between plugin main/UI threads.
- Document mutation based on unvalidated inputs.
- Mixing plugin runtime concerns with Next.js backend concerns.
- Large formatting-only diffs that hide functional changes.
- Editing generated build artifacts instead of source files.

## When Adding Tests or Lint Later
- Add `test` scripts in root and/or `apps/web/package.json` as appropriate.
- Document full-suite and single-test commands in this file immediately.
- Prefer deterministic unit tests for geometry, schemas, and message/state logic.
- For backend, add route-level tests around payload validation and error envelopes.
