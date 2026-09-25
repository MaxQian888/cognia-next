import {
  definePlugin,
  definePluginManifest,
  type BotHandlerV1,
  type PluginBotDef,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { configSchema, parseConfig } from "./config"
import { executeWork } from "./execute"
import { monitor } from "./monitor"

export const githubDevinBotDef = {
  id: "repository-monitor",
  name: "GitHub Devin Bot",
  version: "1.0.0",
  description:
    "Monitor github.com issues, pull requests, and CI with approval or explicitly authorized automatic publication. GitHub Enterprise Server is not supported yet.",
  executor: "handler",
  entry: "dist/index.js",
  export: "githubDevinBot",
  triggers: [
    {
      id: "poll",
      kind: "poll",
      label: "Monitor repository",
      everyMs: 60_000,
      cursor: "github",
      enabledByDefault: false,
      concurrencyKey: "github-monitor",
    },
    {
      id: "github",
      kind: "event",
      source: "integration",
      label: "GitHub events",
      enabledByDefault: false,
      types: [
        "issues.opened",
        "issues.closed",
        "pull_request.opened",
        "pull_request.synchronize",
        "pull_request.ready_for_review",
        "pull_request.closed",
        "check_run.completed",
        "workflow_run.completed",
      ],
      concurrencyKey: "github-monitor",
      conditions: { repositoryConfigKey: "repository" },
    },
    { id: "scan", kind: "manual", label: "Check repository now" },
    {
      id: "backfill",
      kind: "manual",
      label: "Process selected historical items",
      inputSchema: {
        type: "object",
        properties: {
          numbers: {
            type: "string",
            title: "Issue / PR numbers",
            description: "Comma-separated item numbers",
          },
        },
        required: ["numbers"],
      },
    },
    {
      id: "work",
      kind: "manual",
      label: "Process queued repository work",
      concurrencyKey: "github-work:{{resource.scope}}",
      holdConcurrencyWhileWaiting: false,
    },
  ],
  requires: {
    credentials: [{ id: "github", label: "GitHub account", integration: "github" }],
    integrationActions: ["github.openPr", "github.reviewPr"],
  },
  policy: {
    maxAuthority: "bypassPermissions",
    maxAutonomy: "autopilot",
    maxConcurrentRuns: 1,
    maxRunDurationMs: 1_800_000,
    allowSelfTriggering: false,
  },
  configSchema,
} satisfies PluginBotDef

/**
 * `plugin.json` holds identity, permissions and runtime compatibility; the Bot
 * definition is authored here next to the handler it names. `build.mjs`
 * regenerates `plugin.json` from this merge so the installed manifest and the
 * built-in module cannot drift.
 *
 * github.com only: Bot-bound reads go through
 * `ctx.integrations.authenticatedRequest(binding, url)`, which confines them to
 * the bound account's API origin, but the SDK does not tell a Bot what that
 * origin is — so a GitHub Enterprise Server account cannot be addressed yet.
 */
export const manifest = definePluginManifest({
  ...manifestJson,
  bots: [githubDevinBotDef],
})

/** Captured on activation exactly as other first-party contributed handlers are wired. */
let activeContext: PluginContext | undefined
export function createGithubDevinBot(context: PluginContext): BotHandlerV1 {
  return async (run) => {
    run.signal.throwIfAborted()
    const config = parseConfig(run.config)
    return run.event.triggerId === "work"
      ? executeWork(context, run, config)
      : monitor(context, run, config)
  }
}
export const githubDevinBot: BotHandlerV1 = (run) => {
  if (!activeContext) throw new Error("GitHub Devin Bot is not active")
  return createGithubDevinBot(activeContext)(run)
}

export default definePlugin({
  manifest,
  activate: (context) => {
    activeContext = context
  },
  deactivate: () => {
    activeContext = undefined
  },
})
