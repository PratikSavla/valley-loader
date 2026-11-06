// SPDX-License-Identifier: AGPL-3.0-only
// Vite handles CSS side-effect imports; tell TypeScript they exist (tsconfig.web.json sets "types": []).
declare module '*.css';
