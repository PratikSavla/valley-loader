// SPDX-License-Identifier: AGPL-3.0-only
// electron-builder afterPack hook: npm can install 7zip-bin's binaries without the exec bit.
// Fix it inside the packaged app so the app never has to chmod files in its own bundle at runtime.
const { chmodSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const unpacked = join(context.appOutDir, appName, 'Contents', 'Resources', 'app.asar.unpacked');
  for (const arch of ['arm64', 'x64']) {
    const bin = join(unpacked, 'node_modules', '7zip-bin', 'mac', arch, '7za');
    if (existsSync(bin)) chmodSync(bin, 0o755);
  }
};
