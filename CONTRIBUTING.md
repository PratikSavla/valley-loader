# Contributing to Valley Loader

Thanks for helping. Bug reports, collection compatibility reports and pull requests are all welcome.

## Ground rules

- **Don't automate the Nexus website.** Pull requests that script clicks on "Slow download", scrape download keys or otherwise bypass the free/Premium split will not be merged. They break the Nexus Mods terms and put users' accounts at risk.
- **Never touch the user's real game `Mods` folder.** Every collection deploys to its own profile.
- **Treat collection data as untrusted.** That covers names, instructions, URLs, archive contents and patch paths. Render text as plain text, validate paths and keep downloads inside the app's own folders.
- **Keep secrets out of logs and URLs.** The Nexus API key and signed CDN links must never appear in either.

## Development setup

You need macOS (Apple silicon) and Node.js 22 or later.

```bash
npm install
```

```bash
npm run dev
```

## Before you open a pull request

All of these must pass, with zero lint warnings:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Code conventions:

- **TypeScript strict mode.** No `any`.
- **Size limits.** Files stay at or under 300 lines and functions at or under 50 lines; ESLint enforces both.
- **Pure modules.** Modules in `src/main/{nexus/api,nexus/nxm,collection,download,install,game}` must not import `electron`. Inject anything that depends on the environment so the module can be unit-tested.
- **Errors.** Never swallow an error. Log it with context, then rethrow it or show it in the UI.
- **Tests.** Add tests for every behaviour change, and make each test assert something meaningful.

## Reporting a collection that doesn't install correctly

Include:

- the collection link and revision
- the mod that failed and the message Valley Loader showed
- your SMAPI log, if the game starts: `~/.config/StardewValley/ErrorLogs/SMAPI-latest.txt`

## License of contributions

By contributing, you agree that your contributions are licensed under the GNU AGPL v3, the project's license.
