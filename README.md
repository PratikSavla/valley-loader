# Valley Loader

Install [Nexus Mods](https://www.nexusmods.com/games/stardewvalley/collections) **Stardew Valley collections on macOS**: paste a collection link and Valley Loader handles the rest.

Vortex, the official Nexus mod manager, only runs on Windows. Valley Loader is a small, focused macOS app that does one job: install a Stardew Valley collection exactly as its curator built it, then launch the game with SMAPI.

> **Unofficial project.** Valley Loader is not affiliated with or endorsed by Nexus Mods, Black Tree Gaming Ltd., ConcernedApe, or the SMAPI project. "Stardew Valley" is a trademark of ConcernedApe LLC. "Nexus Mods" and "Vortex" are trademarks of Black Tree Gaming Ltd.

## Features

- **Paste a link, get a modded game.** Valley Loader accepts collection links such as `https://www.nexusmods.com/games/stardewvalley/collections/tckf0m`.
- **Installs exactly what the curator tested.**
  - Every mod is pinned to the exact file in the collection.
  - Load-order rules decide which mod wins a file conflict, which matters for config-override mods.
  - Bundled files, per-file hash lists and the curator's binary patches are applied, as in Vortex.
- **Your game stays clean.**
  - Each collection installs into its own profile folder, and SMAPI is launched with `--mods-path`.
  - Your existing `Mods` folder is never touched.
  - Removing a collection deletes its profile folder.
- **Guided setup for new players.** A first-run checklist covers:
  - macOS
  - the game install
  - the SMAPI version the collection needs
  - free disk space
  - your Nexus API key
  - Nexus sign-in
  - the `nxm://` link handler

  Every failing check comes with step-by-step fix instructions.
- **Resumable.** Quit partway through and continue later. Downloaded archives are cached and checked against the collection's md5.
- **Collection updates.** Valley Loader notices when the curator publishes a new revision and shows what changed: added, changed and removed mods, how many clicks the update needs, and SMAPI requirements. You choose when to update.

## Free vs. Premium Nexus accounts

Nexus only gives a file download link to a free account after you click **Slow download** on the website. Valley Loader respects that:

| Account | What you do |
| --- | --- |
| **Free** | Valley Loader opens each mod's file page in its own Nexus window. You click **Slow download** once per mod. Downloading, unpacking, patching and installing happen automatically, and the next page opens on its own. |
| **Premium** | Nothing. The whole collection downloads through the Nexus API. |

Valley Loader never scripts clicks on the Nexus website or scrapes download links. Doing that would break the [Nexus Mods terms](https://help.nexusmods.com/article/18-terms-of-service) and could get your account banned.

## Requirements

- macOS on Apple silicon. Valley Loader is developed and tested on arm64; Intel builds are untested.
- Stardew Valley 1.6 or later from Steam or GOG, launched at least once.
- [SMAPI](https://smapi.io) installed. The setup check tells you if a collection needs a newer version.
- A Nexus Mods account and a [personal API key](https://next.nexusmods.com/settings/api-keys).

## Install

Download `Valley-Loader-<version>-arm64-mac.zip` from the [Releases](https://github.com/pratiksavla/valley-loader/releases) page, unzip it and move **Valley Loader.app** to Applications.

Release builds are ad-hoc signed, not notarized, so macOS blocks the first launch. Allow it in one of two ways:

- Right-click the app, choose **Open**, then confirm, **or**
- Run this once in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Valley Loader.app"
```

## Using it

1. Open Valley Loader and follow the setup check. Paste your Nexus API key when asked; it is stored encrypted in the macOS Keychain.
2. Copy a collection link from nexusmods.com and paste it on the Home screen.
3. Review the mod list, switch optional mods on or off, then press **Start install**.
4. Free accounts: click **Slow download** in the Nexus window for each mod. Valley Loader moves to the next mod by itself.
5. Press **Play**. Steam must be running for the Steam version of the game.

## Privacy and security

- **Your API key** is stored with Electron `safeStorage` (macOS Keychain). It is sent only to `api.nexusmods.com`, never to download CDNs or other hosts, and is never logged.
- **Network traffic** goes only to Nexus Mods (API, website, CDN) and to the direct download links a collection itself lists. Direct links must use https and are checked against the collection's md5.
- **No telemetry.**
- **Downloaded archives** are unpacked defensively: path traversal, absolute paths and symlinks are rejected.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
```

```bash
npm run dev
```

Quality gates (all must pass, with zero lint warnings):

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Build the app bundle into `release/`:

```bash
npm run package
```

`npm run live-check` exercises the real Nexus API with `NEXUS_API_KEY` from a local `.env` file (see `.env.example`). It downloads a collection into the git-ignored `tests/fixtures/live/`.

Architecture notes live in [project-docs/architecture.md](project-docs/architecture.md). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright © 2026 Pratik Savla.

Valley Loader is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License, version 3** as published by the Free Software Foundation. See [LICENSE](LICENSE).

Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
