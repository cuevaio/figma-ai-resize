# AGENTS.md

## Purpose
- This file gives coding agents repository-specific instructions for safe, consistent changes.
- Follow this file unless a direct user request conflicts with it.
- Keep changes minimal, typed, and aligned with existing Create Figma Plugin patterns.

## Project Snapshot
- Stack: TypeScript + Create Figma Plugin.
- Runtime: Figma Plugin API (`main` thread) + browser UI iframe (`ui` thread).
- Node version target: v22 (from `README.md`).
- Package scripts are in `package.json`; source code lives in `src/`.
- Generated outputs: `build/` and `manifest.json` (both gitignored).

## Repository Layout
- `src/main.ts`: plugin entrypoint, selection handling, resize execution.
- `src/ui.ts`: UI rendering, DOM events, and outgoing messages.
- `src/messages.ts`: shared message contracts and preset constants.
- `src/placement.ts`: algorithm to place newly created frames.
- `src/placement-geometry.ts`: rectangle math helpers.
- `build/*.js`: generated bundles; do not hand-edit.

## Source of Truth
- Treat `src/messages.ts` as the canonical schema for main<->ui communication.
- When changing message types, update sender and receiver paths in one change.
- Keep discriminated unions exhaustive in `if`/`switch` handling.

## Install and Build Commands
- Install dependencies: `bun install`
- Build (typecheck + bundle + minify): `bun run build`
- Watch mode (rebuild on changes): `bun run watch`
- Show available scripts: `bun run`

## Lint / Typecheck / Test Status
- There is currently no dedicated `lint` script.
- There is currently no `test` script.
- No test files currently exist under `src/`.
- `bun run build` is the current validation command and includes typechecking.
- Do not claim lint/test passed unless those tools exist and were actually run.

## Single Test Execution
- Not available in current repo state (no test framework configured).
- If asked to run one test, explain tests are not configured yet.
- If you add a test runner, also add scripts in `package.json` and update this file.
- Suggested future convention (Vitest example): `bun run test -- src/foo.test.ts -t "case name"`

## Important Command Caveats
- Avoid raw `bunx tsc --noEmit`; it conflicts with plugin typings (`console`/`fetch` redeclare errors).
- Prefer `bun run build` for reliable typecheck behavior in this repository.
- Rebuild before handoff when touching message contracts or placement logic.

## Coding Style: Imports
- Use ES module imports with single quotes and no trailing semicolons.
- Keep external imports first, then a blank line, then local imports.
- Use type-only imports for types (`import type { ... }` or inline `type Foo`).
- Keep import groups concise and readable.

## Coding Style: Formatting
- Use 2-space indentation.
- Prefer guard clauses and early returns over deep nesting.
- Keep functions focused; extract helpers for non-trivial logic.
- Prefer descriptive names over abbreviations.
- Match existing punctuation style: no semicolons, consistent trailing commas.

## Coding Style: Types
- Keep code strict-mode compatible (project extends a strict TS config).
- Type function parameters and return values explicitly.
- Model state with unions/discriminated unions (see `InitSelectionStatePayload`).
- Avoid `any`; use precise unions, intersections, and type guards.
- Preserve literal unions for message names and mode values.

## Naming Conventions
- `PascalCase` for type aliases and type models.
- `camelCase` for variables, functions, and parameters.
- `UPPER_SNAKE_CASE` for module-level constants.
- Use kebab-case filenames for multiword modules.
- Keep message `type` strings stable and explicit (`'APPLY_RESIZE'`, `'SELECTION_STATE'`).

## Control Flow and Validation
- Validate external inputs early (UI messages, selection state, parent checks).
- Return quickly on invalid state instead of nesting large branches.
- Re-check selection immediately before mutation operations.
- Handle lookup misses (`undefined`) explicitly and notify users clearly.

## Error Handling Guidelines
- Wrap mutation-heavy Figma operations in `try/catch` when failure is possible.
- Use `figma.notify(...)` for user-visible failures.
- After failure, use safe fallback behavior (for example, refresh selection state).
- Use `_error` for intentionally unused caught errors.
- Do not silently swallow errors that affect user flow.

## Figma Plugin-Specific Practices
- Keep `main` and `ui` responsibilities separated.
- Main thread owns document mutation (`resize`, `createFrame`, selection updates).
- UI thread owns DOM rendering and sends typed `pluginMessage` payloads.
- After mutation, keep selection and viewport coherent (`scrollAndZoomIntoView`).
- Avoid partial state updates when creation/modification fails.

## Placement Logic Expectations
- Preserve collision-avoidance behavior in `src/placement.ts`.
- Keep placement ordering deterministic.
- Keep geometry helpers pure and side-effect free.
- Prefer focused helper functions over repeated inline coordinate math.

## UI and Messaging Expectations
- Reflect selection validity immediately in UI state.
- Keep status/error text concise and action-oriented.
- Keep mode/preset values synchronized with shared types.
- Do not accept untyped message payloads from `window.onmessage`.

## Generated Files and Manual Edits
- Do not manually edit `build/main.js` or `build/ui.js`.
- Do not manually maintain generated `manifest.json` output.
- Change source in `src/`, then run `bun run build`.

## Cursor and Copilot Rules
- No `.cursor/rules/` directory found.
- No `.cursorrules` file found.
- No `.github/copilot-instructions.md` file found.
- This `AGENTS.md` is the active agent guidance file until those appear.

## Change Checklist for Agents
- Confirm requested behavior against existing message/type contracts.
- Update `src/messages.ts` first when adding cross-thread payloads.
- Keep changes localized to relevant files.
- Run `bun run build` before final handoff.
- If you add lint/tests, update this file with exact commands.

## When Adding Tests Later
- Add a `test` script in `package.json`.
- Document exact full-suite and single-test commands in this file.
- Start with deterministic unit tests for geometry and message/state logic.
- Prefer tests that run without requiring the Figma desktop runtime.

## When Adding Linting Later
- Add a `lint` script in `package.json`.
- Prefer autofix-capable rules plus CI-safe check mode.
- Document both full lint and file-scoped lint commands.

## Agent Handoff Notes
- State what commands you ran and whether they succeeded.
- If a command is unavailable, say so explicitly.
- Reference changed files precisely in final responses.
- Keep user-facing explanations concise and factual.

## Anti-Patterns to Avoid
- Do not place UI-only DOM logic into `src/main.ts`.
- Do not mutate document nodes from unvalidated message payloads.
- Do not bypass shared types with duplicated ad-hoc payload shapes.
- Do not introduce unrelated formatting/tooling churn.
