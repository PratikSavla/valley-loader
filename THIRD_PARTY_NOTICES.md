# Third-party notices

Valley Loader is licensed under the GNU AGPL v3 (see [LICENSE](LICENSE)). The packaged app also ships the components below. Each keeps its own license.

## Bundled in the app

| Component | License | Notes |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) (includes Chromium and Node.js) | MIT, plus the Chromium and Node.js licenses | Full texts ship inside the app bundle as `LICENSES.chromium.html` and `LICENSE`. |
| [React](https://github.com/facebook/react), React DOM | MIT | |
| [zod](https://github.com/colinhacks/zod) | MIT | |
| [7zip-bin](https://github.com/develar/7zip-bin) | MIT (the wrapper package) | Ships the `7za` executable from **p7zip 16.02**, licensed under the GNU LGPL v2.1 or later. Valley Loader runs `7za` as a separate program. p7zip source code: <https://sourceforge.net/projects/p7zip/files/p7zip/16.02/>. |
| [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) | MIT (the JavaScript wrapper) | Contains RARLAB's **UnRAR** source compiled to WebAssembly. UnRAR is distributed under the [UnRAR license](https://www.rarlab.com/license.htm), which allows free use and redistribution but forbids using the code to re-create the RAR compression algorithm. The Free Software Foundation considers this license incompatible with the GPL family. Valley Loader uses it only to extract `.rar` mod archives. |

## Not bundled

These tools are used only during development and are never shipped in the app: TypeScript, Vite, electron-vite, electron-builder, ESLint, typescript-eslint and Vitest.

## Data and services

- **Collections and mods are not included.** Valley Loader downloads them at runtime from Nexus Mods on the user's behalf, under the user's own Nexus account and the [Nexus Mods terms of service](https://help.nexusmods.com/article/18-terms-of-service).
- **The test fixtures** in `tests/fixtures/` are synthetic or trimmed: they contain mod and file ids with generic names and no curator content.
