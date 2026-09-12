/** Host compatibility barrel for the portable CLI template engine. */

export {
  assertConfinedPathParams,
  buildArgv,
  CliTemplateError,
  isProtectedCliPath,
  parseOutput,
  resolveCwd,
} from "@cognia/plugin-sdk/api/cli-tool"
export type { CwdContext } from "@cognia/plugin-sdk/api/cli-tool"
