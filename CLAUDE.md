# Valley Loader

macOS Electron app that installs Nexus Mods **Stardew Valley collections** (Vortex is Windows-only).
Plan of record: `project-docs/architecture.md`.

## Stack
Electron 45 + electron-vite 6 + Vite 8 + React 19 + TypeScript 6 (strict, `noUncheckedIndexedAccess`), zod 4, vitest 5, ESLint 9 (typescript-eslint).
Import shared types with `@shared/*` (→ `src/shared`).

## Layout
- `src/shared/` — types + IPC contract shared by main/preload/renderer. No Node/Electron imports.
- `src/main/` — main process. Pure modules (`nexus/api.ts`, `nexus/nxm.ts`, `collection/*`, `download/*`, `install/*`, `game/*`, `prereqs.ts`) must NOT import `electron`; inject anything environment-specific so they're unit-testable. Electron glue lives in `index.ts`, `main-window.ts`, `ipc.ts`, `nexus/browser.ts` (and `state/store.ts`, `nexus/auth.ts`, `install/runner*.ts`, which receive Electron objects by injection).
- `src/preload/` — contextBridge exposing `ValleyApi` (`src/shared/ipc.ts`) as `window.valley`.
- `src/renderer/` — React UI.
- `tests/` — vitest (`tests/**/*.test.ts`), fixtures in `tests/fixtures/`.

## Commands
- `npm run typecheck && npm run lint && npm test` — must all pass, zero warnings.
- `npm run dev` — run the app. `npm run package` — build `release/mac-arm64/Valley Loader.app`.
- `npm run live-check` — hits the real Nexus API with `NEXUS_API_KEY` from `.env`.

## Rules
- Never automate the Nexus website (no scripted clicks on "Slow download", no scraping download keys). Free accounts click once per mod; Premium uses the API directly.
- Never touch the user's real `Contents/MacOS/Mods` folder — every collection deploys to its own profile and SMAPI is launched with `--mods-path`.
- The Nexus API key is stored only via Electron `safeStorage`; never log it or put it in URLs.
- Send `apikey`, `Application-Name: Valley Loader`, `Application-Version`, `User-Agent` on every Nexus API call.
- License: AGPL-3.0-only. Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-only`. Never commit `.env`, `tests/fixtures/live/` (downloaded curator content) or `release/`.
- Files ≤ 300 lines, functions ≤ 50 lines, no `any`, never swallow errors (log with context, then rethrow or surface in UI).
