// SPDX-License-Identifier: AGPL-3.0-only
// Button labels shared by the setup-check copy (src/main/prereqs.ts) and the renderer that draws the buttons,
// so a step that says 'press "X"' always names a button that exists. No Node/Electron imports.

export const PREREQ_BUTTON_LABELS = {
  recheck: 'Re-check',
  /** The fixUrl link under a check. */
  help: 'Step-by-step help',
  pickGameFolder: 'Choose game folder',
  /** The API key form shown inline under the Nexus account check. */
  enterApiKey: 'Save key',
  openNexusLogin: 'Sign in to Nexus',
  registerNxm: 'Open links in Valley Loader',
} as const;
