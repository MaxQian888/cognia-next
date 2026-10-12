import {
  definePlugin,
  definePluginManifest,
  type BotHandlerV1,
  type PluginBotDef,
  type PluginContext,
} from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import { configSchema } from "./config"
import { handleCommandRun } from "./handler"
import { GITHUB_SLOT } from "./identity"
import { COMMAND_EVENT_TYPES } from "./receive"

export const githubCommentBotDef = {
  id: "comment-commands",
  name: "GitHub Comment Bot",
  version: "1.0.0",
  description:
    "Answer allowlisted collaborators' @-mention commands in issue and pull request comments: ask questions and get read-only reviews, with status, cancel and help.",
  executor: "handler",
  entry: "dist/index.js",
  export: "githubCommentBot",
  triggers: [
    {
      id: "github",
      kind: "event",
      source: "integration",
      label: "GitHub comments",
      enabledByDefault: false,
      types: [...COMMAND_EVENT_TYPES],
      // Receiving is short and never waits on a person; one at a time keeps
      // an edit and its original from racing.
      concurrencyKey: "github-cmd-receive",
      conditions: { repositoryConfigKey: "repository" },
    },
    {
      id: "poll",
      kind: "poll",
      label: "Poll comments",
      everyMs: 60_000,
      everyMsConfigKey: "pollIntervalMs",
      cursor: "comments",
      enabledByDefault: false,
      concurrencyKey: "github-cmd-receive",
    },
    {
      id: "execute",
      kind: "manual",
      label: "Answer a queued command",
      // One answer per repository at a time; a parked publication decision
      // does not hold the slot.
      concurrencyKey: "github-cmd:{{resource.scope}}",
      holdConcurrencyWhileWaiting: false,
    },
    {
      id: "check",
      kind: "manual",
      label: "Check setup",
      concurrencyKey: "github-cmd-check",
    },
    {
      id: "reply",
      kind: "manual",
      label: "Post a control reply",
      concurrencyKey: "github-cmd-reply:{{resource.id}}",
      holdConcurrencyWhileWaiting: false,
    },
  ],
  requires: {
    credentials: [{ id: GITHUB_SLOT, label: "GitHub account", integration: "github" }],
    integrationActions: [
      "github.commentIssue",
      "github.commentPr",
      "github.replyToReviewComment",
      "github.updateComment",
      "github.reviewPr",
    ],
  },
  policy: {
    // Read-only answers: the agent never needs more than accept-edits, and
    // the checkout is diff-checked after every run.
    maxAuthority: "acceptEdits",
    maxAutonomy: "autopilot",
    // Receiving, one answer and one control reply can run together.
    maxConcurrentRuns: 3,
    maxRunDurationMs: 1_800_000,
    allowSelfTriggering: false,
  },
  configSchema,
} satisfies PluginBotDef

/**
 * `plugin.json` holds identity, permissions and runtime compatibility; the Bot
 * definition is authored here next to its handler. `build.mjs` regenerates
 * `plugin.json` from this merge so the installed manifest and the built-in
 * module cannot drift.
 */
export const manifest = definePluginManifest({
  ...manifestJson,
  bots: [githubCommentBotDef],
})

let activeContext: PluginContext | undefined

export function createGithubCommentBot(context: PluginContext): BotHandlerV1 {
  return (run) => handleCommandRun(context, run)
}

export const githubCommentBot: BotHandlerV1 = async (run) => {
  if (!activeContext) throw new Error("GitHub Comment Bot is not active")
  return createGithubCommentBot(activeContext)(run)
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
