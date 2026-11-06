# Plan: "Valley Loader": Nexus collections for Stardew Valley on macOS

## Context

Vortex only runs on Windows. The Nexus Mods App, Nexus's cross-platform manager, was discontinued in January 2026 and never shipped for macOS. Stardew Valley runs natively on macOS (Steam/GOG), and SMAPI supports it (the Steam build lives at `~/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS`). What's missing is the Vortex experience: paste a collection link and everything installs.

Porting Vortex isn't practical, so we build a small, focused **Electron + React + TypeScript (strict)** app that does just this job.

**Design decisions**
- Desktop GUI app.
- Personal API key for sign-in, stored encrypted with Electron `safeStorage` (backed by the macOS Keychain). The app never handles the Nexus password.
- Works with free Nexus accounts (Premium makes it fully automatic).
- The user pastes a collection URL and everything else is automated, except one click per mod.

**The free-account limit.** Nexus returns a file download URL to a free account only with the `key` and `expires` values from the website's **Slow download** button, which arrive in an `nxm://` link. Vortex works the same way. We will **not** automate that click with Playwright, Selenium or similar: it breaks Nexus's terms, it means fighting bot detection, and it puts the user's account at risk. Instead the app opens each file page, the user clicks, and the app does the rest. A Premium key skips the browser step entirely, using the same code path.

**Already verified**
- The public GraphQL API returns `tckf0m` without auth: "Stardew Valley VERY Expanded", revision 114, 104 mod files, about 465 MB, `downloadLink` `/v2/collections/994/revisions/802199/download_link`. That endpoint needs the `apikey` header, and free users may call it (Vortex sends collection archives straight through the API).

## Key facts from the Vortex source (Nexus-Mods/Vortex monorepo)

- **Collection archive.** A `.7z` file containing:
  - `collection.json`, which holds `{info, mods[], modRules[], collectionConfig}`
  - `bundled/<fileExpression>` (mods shipped inside the collection)
  - `patches/<mod>/<file>.diff` (rare for Stardew)
- **Each `mods[]` entry:**
  - `name, version, optional, domainName, phase, hashes?, choices?, patches?, instructions?`
  - `source {type: nexus|bundle|direct|browse|manual, modId, fileId, md5, fileSize, logicalFilename, fileExpression, url, updatePolicy}`
- **Download link endpoint.** `GET /v1/games/stardewvalley/mods/{modId}/files/{fileId}/download_link.json?key&expires` returns `[{URI, name, short_name}]`. Required headers: `apikey`, `Application-Name`, `Application-Version`, `User-Agent`.
- **Rate limits.** 20k requests per day, then 500 per hour, reported in the `X-RL-*` headers.
- **File page for free users.** `https://www.nexusmods.com/stardewvalley/mods/{modId}?tab=files&file_id={fileId}&nmm=1`. Clicking Slow download produces `nxm://stardewvalley/mods/{m}/files/{f}?key=…&expires=…&user_id=…`. Reject the link if `user_id` doesn't match the signed-in user.
- **Stardew installer rules (from Vortex's game extension):**
  - An archive with `SMAPI.Installer.dll` is SMAPI itself. Don't install it; show a notice instead.
  - An archive with a top-level `Content/` is a root mod and goes into the game root. Warn the user, because this modifies the game.
  - Each folder containing a `manifest.json` (not under `locale/`) is copied to `Mods/<its path inside the archive>/`, wrapper folders included (e.g. `Mods/Ridgeside Village/RidgesideVillage/`). Config packs such as VERY Configured and the collection's `patches` use these same paths.
  - Anything else falls back to copying the archive root into `Mods/` as packed (only a lone top-level `Mods/` folder is stepped into). If that leaves loose files in `Mods/`, the mod gets a warning.
- **Order rules.**
  - `phase` decides install order.
  - `modRules` before/after decide which mod wins a file conflict. This matters for "VERY Configured" (mod 20870), whose `config.json` files must overwrite other mods' files.
  - When `hashes` is present ("replicate" mode), Vortex's list installer hashes every extracted file and installs exactly the listed files, each at its listed path, matched by md5. Missing files only warn.
  - `patches` maps a staging-relative path to the CRC32 of the **original** file. `patches/<mod name>/<path>.diff` (BSDIFF40) is applied only when the file's CRC matches. A mismatch is skipped with a log line, and the mod stays installed.

## Design

### Isolated profile per collection
Each collection gets its own Mods folder at `~/Library/Application Support/Valley Loader/profiles/<slug>/Mods`. The app launches `StardewModdingAPI --mods-path <that folder>`. The user's existing `Contents/MacOS/Mods` is never touched, collections can't clash with each other, and uninstalling is just deleting the folder. A per-profile `files.json` records which mod owns each file, so the app can report overwrites and update single mods.

### The click-through flow (free account)
1. **Paste the URL.** The app resolves the slug and revision through GraphQL, downloads the `.7z` archive through the API, and parses and validates `collection.json` with zod.
2. **Build the plan.** Group mods by phase and order them by `modRules`. Mark `bundle` mods (no click needed) and mods already in the profile cache with a matching md5 (skipped). The user chooses which optional mods to include.
3. **Nexus window.** A separate BrowserWindow uses a persistent session partition, so the user signs in to nexusmods.com once and stays signed in. It loads the next pending file page and shows a strip such as "Mod 12 / 104 · Click **Slow download**".
4. **Catch the link.** `session.protocol.handle('nxm')` on that partition catches the link the click produces, with no OS round-trip. The app checks `user_id`, immediately calls `download_link.json`, adds the file to the background download queue, and loads the next page.
   - **Fallback:** register `nxm` with the OS (electron-builder `protocols` plus the `open-url` event) so Slow download clicks in Safari or Chrome also reach the app. This covers the case where Nexus's login blocks the embedded window.
5. **Download and install in the background** (up to 3 downloads at once):
   - Check the md5 against `source.md5` and `fileSize`.
   - Extract the archive: `7zip-bin` handles zip and 7z, `node-unrar-js` (WASM) handles rar.
   - Run the Stardew installer rules.
   - Copy files in phase/rule order so later mods win conflicts.
6. **Resume.** Queue state is saved after every step, so the user can quit at mod 40 and continue later. Download keys expire, so mods that were caught but never downloaded go back to "needs click".
7. **Other source types:**
   - `direct`: plain download from the URL.
   - `browse`: open the page in the Nexus window and catch the download with `will-download`.
   - `manual`: show the instructions and a "pick downloaded file" button.
8. **Play.** Copy SMAPI's own bundled mods (ConsoleCommands, SaveBackup) from the game's `Mods/` into the profile (read-only on the game folder, once per SMAPI version, deployed first so collection files win), then launch SMAPI with `--mods-path`. Before launch, check that the installed SMAPI version meets the collection's SMAPI entry (mod 2400). If it doesn't, link to the SMAPI installer, since SMAPI on macOS has to be installed manually.

### Links and windows from outside the app
- A collection `nxm://` link (from a website, another app, or the Nexus window) is only a proposal (`pendingCollection` in the snapshot). The main window asks the user to confirm before anything is downloaded; moving a profile to an older revision additionally needs `allowDowngrade`.
- Only the packaged `index.html` (main frame) may call IPC, and the main window never navigates away from it.
- The Nexus window denies web permissions except fullscreen and clipboard writes for nexusmods.com, frames may only navigate to https, popups to other sites need the user's OK, and its downloads are saved under `downloads/captured/<random>-<name>` (never on a download-cache path). A window download is accepted for a `browse` mod only when it matches the collection's md5/size, or comes from the mod page's site when the collection lists neither.
- `direct` mods must be https and are checked against the collection's md5/size; every Nexus/direct archive is md5-checked again right before it is unpacked.

### Several collections at once
- One click cursor is shared: when the profile holding it runs out of clicks (or is paused), it moves to another running profile. Pause cancels only that profile's downloads.
- A mod with work in flight (resolve, download, install) is never planned a second time by Resume or reselect.
- Resume also retries failed mods. The SMAPI row (mod 2400) follows the installed SMAPI version whenever the game is re-detected.

### New collection revisions (added after v1)
Collections pin exact files (`updatePolicy: 'exact'`), and curators ship updates as new **revisions**. The app never updates single mods to a newer Nexus file: that would break the curator's testing and any collection `patches`, whose CRCs target the pinned file.
- **Check** (`install/runner-updates.ts`, `UpdateService`): public GraphQL `getCollection(slug)` gives the latest published revision; when it is newer, `getRevisionModFiles(slug, latest)` is diffed against the plan by `collection/revision-diff.ts` (exact fileId first, then files still pinned but deleted on Nexus count as unchanged, then leftovers of the same modId pair as "changed", same file name first; bundled mods are not in `modFiles` and are left out). The result is stored as `ProfileState.update` in `state.json`; failures become a plain-language `update.error` (full error logged, no toast). A manual re-resolve keeps a known newer revision (and its diff, when it was computed from the revision being resolved).
- **When:** about 10 s after launch, every 6 h, and when a profile becomes active with a check older than 1 h (debounced). One check per slug at a time; checking while installing is fine.
- **Apply** (`applyUpdate`): refused while the profile is installing or still finishing downloads. Waits for a check already in flight, then re-resolves the profile at the previewed revision (or the newer one that check found) through the normal resolve path (kept mods stay installed, new/changed mods become pending, an optional mod the user had switched on stays on when only its pinned file changed, dropped mods are unstaged, the old archive is removed). It then clears `update` and runs a real check instead of writing a made-up result. It never starts an install: the user presses Resume.
- **Lock:** `Runner.resolveCollection` holds a per-collection lock (`install/runner-lock.ts`, published as `AppSnapshot.resolving`) for the whole resolve; Start/Resume, Remove, mod toggles, retries and a second resolve of the same collection are refused meanwhile, and the resolve re-reads the profile after the archive download (a profile removed or started meanwhile is never overwritten).
- **UI:** a badge on the Home card, and on the Collection page a banner with added / changed / removed mods, the free-account click estimate and a SMAPI warning when the new revision needs a newer SMAPI. Update is disabled (with the reason shown) while installing or mods are still installing, while the collection is being updated, and without a working API key (checking is public, downloading the collection is not). Manual checks announce their result.

### Onboarding and prerequisite checks (user request, added during build)
A first-run wizard, also reachable later from "Setup check", runs these checks. Each one shows pass, warn or fail, and every failing check comes with fix steps and a "Re-check" button:
1. macOS and CPU architecture.
2. Stardew Valley is found (auto-detected, or pick the folder manually) and its version is read.
3. SMAPI is installed and its version is read. If not, show the SMAPI install steps for macOS with a link.
4. There's enough free disk space for the collection.
5. The Nexus API key is valid, with a walkthrough of where to get it. Show the username and whether the account is Premium.
6. The user is signed in to nexusmods.com in the built-in window (free accounts only).
7. The app is registered as the `nxm://` handler (warn only).

Once setup is done, the main screens show short contextual hints: what to paste, what to click in the Nexus window, and why one click per mod is needed. Hints can be dismissed and stay dismissed.

### Out of scope for v1
- FOMOD `choices`. These are rare for Stardew. Detect them and show a warning listing the affected mods.
  (Binary `patches` and `hashes` file lists are supported: `install/patches.ts`, `install/hashes.ts`, wired in `install/runner-extras.ts`, using a pure-TS bspatch and bzip2 decoder.)
- Code signing and notarization. The app ships as an ad-hoc signed `.app` for personal use.

## Project layout (follows ~/.claude/CLAUDE.md: strict TS, files under 300 lines, required dotfiles)

```
nexus-app/
├── package.json, tsconfig*.json, electron.vite.config.ts, electron-builder.yml
├── .gitignore, .dockerignore, .env.example (NEXUS_API_KEY for dev tests only), CLAUDE.md
├── src/main/
│   ├── index.ts                 app lifecycle, nxm open-url, unhandledRejection handler
│   ├── ipc.ts                   typed IPC channels
│   ├── state/store.ts           singleton JSON store (settings, profiles, queue)
│   ├── nexus/api.ts             REST + GraphQL client, headers, rate-limit tracking
│   ├── nexus/auth.ts            API key validate (/v1/users/validate.json), safeStorage
│   ├── nexus/nxm.ts             nxm URL parse/validate
│   ├── nexus/browser.ts         Nexus BrowserWindow, partition, nxm interception
│   ├── collection/schema.ts     zod schema for collection.json
│   ├── collection/resolve.ts    URL → slug → revision → archive → parsed collection
│   ├── collection/plan.ts       phases, modRules ordering, skip/bundle/optional
│   ├── download/queue.ts        concurrent downloads, md5 verify, persistence
│   ├── install/archive.ts       7z/zip/rar extraction (+ hashes filter)
│   ├── install/stardew.ts       manifest/Content/SMAPI detection → file ops
│   ├── install/profile.ts       profile dirs, files.json ownership, conflict order
│   └── game/{detect,launch}.ts  game path + SMAPI version, launch with --mods-path
├── src/preload/index.ts
├── src/renderer/                React: Settings, Home (paste link), Collection, Queue, Profiles
├── tests/                       vitest unit tests + fixtures (sample collection.json, tiny archives)
├── project-docs/                architecture notes
└── scripts/                     build/package helpers
```

## Build order
1. Scaffold the project: electron-vite with React/TS, ESLint, vitest, the required files, and `git init`.
2. Nexus client and settings screen: enter the API key, validate it, show the username and Premium status.
3. Resolve and plan: paste the URL and see the full mod list with status (fetches the archive via the API).
4. Game detection, profiles and the Stardew installer, including bundled mods (no clicks needed yet).
5. Download queue, Nexus window, `nxm` interception and the OS handler fallback.
6. Launch, resume and profile management.
7. Package the `.app` with electron-builder and run end-to-end.

## Verification
- **Unit tests (vitest), with explicit assertions:**
  - nxm parsing, including `user_id` mismatch rejection and expired links
  - zod parsing of a real `collection.json` fixture taken from the `tckf0m` archive
  - planner ordering: a VERY Configured-style config mod must win the file conflict
  - Stardew installer on built fixture archives:
    - one archive containing several manifest folders
    - an archive with `Content/` at its root
    - the SMAPI installer archive
    - an archive whose manifest sits under `locale/`
  - API client against mocked fetch: headers, 401/429 handling, rate-limit headers
- **`npm run typecheck && npm run lint && npm test`** pass with zero warnings.
- **Live check (needs the user's API key in `.env`):**
  - resolve `tckf0m`, confirm 104 mods with names and versions
  - download the collection archive and parse it
- **End-to-end (user clicks along):**
  - install a small collection, then `tckf0m`
  - launch through the app
  - check `~/.config/StardewValley/ErrorLogs/SMAPI-latest.txt`: the mod count loaded should match the plan and no mods should report "skipped" or "failed"
- **Safety check:** `Contents/MacOS/Mods` is unchanged (compare its file list before and after).
