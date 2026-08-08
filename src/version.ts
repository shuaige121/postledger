/**
 * The version, read from package.json — never written down a second time.
 *
 * There were two hand-maintained copies of this string. Both drifted: the CLI
 * still reported 0.1.0 after 0.1.1 shipped, and the MCP server was still
 * reporting it at 0.5.0. A number kept in two places is a number that will
 * disagree with itself; the only reliable fix is to have one place.
 */
import { createRequire } from 'node:module';

export const VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();
