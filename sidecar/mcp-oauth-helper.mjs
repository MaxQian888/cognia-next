// @ts-check
// Keep the shipped path and filename guard: bundled library imports must not read host stdin.
export * from "./src/entry/mcp-oauth-helper.ts"
import { isMcpOauthHelperEntry, runMcpOauthHelper } from "./src/entry/mcp-oauth-helper.ts"
if (isMcpOauthHelperEntry({ importUrl: import.meta.url, argvPath: process.argv[1] })) {
  runMcpOauthHelper()
}
