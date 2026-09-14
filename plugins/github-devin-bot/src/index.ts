import type {
  BotHandlerV1,
  PluginBotDef,
  PluginContext,
  PluginDefinition,
} from "@cognia/plugin-sdk"
import { configSchema, parseConfig } from "./config"
import { executeWork } from "./execute"
import { monitor } from "./monitor"

export const githubDevinBotDef = {
  id: "repository-monitor",
  name: "GitHub Devin Bot",
  version: "1.0.0",
  description:
    "Monitor GitHub issues, pull requests, and CI with approval or explicitly authorized automatic publication.",
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

export const manifest = {
  id: "github-devin-bot",
  name: "GitHub Devin Bot",
  version: "1.0.0",
  type: "frontend",
  description:
    "A GitHub repository maintenance Bot powered by Devin SWE-2, with configurable execution and publication approval.",
  author: "Cognia Official",
  license: "MIT",
  minAppVersion: "0.1.0",
  engines: { cognia: ">=0.1.0" },
  main: "dist/index.js",
  activationEvents: ["startup"],
  dependencies: { "github-delivery": ">=3.0.0" },
  capabilities: ["bot"],
  permissions: [
    "integrations:read",
    "integrations:execute",
    "agent:control",
    "agent:dispatch-external",
    "filesystem:read",
    "filesystem:write",
    "network:fetch",
    "git:read",
    "git:write",
    "database:read",
    "database:write",
  ],
  runtimeCompatibility: {
    tauri: { availability: "supported", entrypoint: "dist/index.js" },
    headless: {
      availability: "supported",
      entrypoint: "dist/index.js",
    },
    browser: {
      availability: "degraded",
      reason:
        "Execution requires a paired Desktop or Headless host with Devin CLI and isolated-workspace support.",
    },
    mobile: {
      availability: "degraded",
      reason:
        "Execution requires a paired Desktop or Headless host with Devin CLI and isolated-workspace support.",
    },
  },
  bots: [githubDevinBotDef],
} as const

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

const definition: PluginDefinition = {
  manifest: manifest as unknown as PluginDefinition["manifest"],
  activate: (context) => {
    activeContext = context
  },
  deactivate: () => {
    activeContext = undefined
  },
}
export default definition
