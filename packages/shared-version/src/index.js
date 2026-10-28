/**
 * Single source of truth for version across the entire Munin ecosystem.
 * Import from this module wherever version needs to be referenced.
 *
 * Usage:
 *   import { VERSION, SERVER_VERSION } from "@kalera/munin-shared-version";
 *
 * Release workflow:
 *   node scripts/bump-version.ts <new-version>
 */
export const VERSION = "1.6.0";
export const SERVER_VERSION = VERSION;
