// SPDX-License-Identifier: AGPL-3.0-only
// SMAPI install/update steps for macOS, shown by the setup check and by the collection page's SMAPI banner.
// Plain sentences without numbers (the UI numbers them). No Node/Electron imports.

export const SMAPI_URL = 'https://smapi.io';

export const SMAPI_INSTALL_STEPS: readonly string[] = [
  'Quit Stardew Valley if it is running.',
  'Open smapi.io and press the big download button to get the latest SMAPI.',
  'Open your Downloads folder and double-click the SMAPI zip file to unzip it.',
  'Open the unzipped folder and double-click "install on macOS.command".',
  'If macOS says it can\'t be opened: right-click the file and choose Open, then Open again. Or go to System Settings → Privacy & Security, scroll down and press "Open Anyway".',
  'A Terminal window opens. Type 1 and press Return to choose Install, and follow the prompts until it says SMAPI is installed.',
];
