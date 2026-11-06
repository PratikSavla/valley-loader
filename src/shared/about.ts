// SPDX-License-Identifier: AGPL-3.0-only
// Project facts shown in the UI's About section (AGPL §5(d) "Appropriate Legal Notices").
export const APP_NAME = 'Valley Loader';
export const SOURCE_URL = 'https://github.com/pratiksavla/valley-loader';
export const LICENSE_NAME = 'GNU Affero General Public License v3.0';
export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
export const COPYRIGHT = 'Copyright © 2026 Pratik Savla';

/** Exact https host + path prefixes (besides the help domains) the app may open in the browser. */
export const PROJECT_LINK_PREFIXES: readonly { host: string; path: string }[] = [
  { host: 'github.com', path: '/pratiksavla/valley-loader' },
  { host: 'www.gnu.org', path: '/licenses/' },
];
