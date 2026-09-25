/**
 * Go Backend Refactor Suite — entry point.
 *
 * A first-party plugin that packages a reusable refactoring system for Go
 * backends out of cognia-next's own features:
 *  - **role characters** (character-pack) — analyst / architect / refactorer /
 *    tester / reviewer / doc-writer.
 *  - **agent.turn** (custom workflow node) — a synchronous, tool-enabled,
 *    cwd-scoped Claude turn (the only path that actually edits code).
 *  - **pipeline.stop** (custom workflow node) — ends a give-up path as a
 *    FAILED run with its reason.
 *  - **skills**, **subagents**, a **review-board team template**, and the
 *    **Go backend refactor pipeline** workflow template.
 *
 * Lifecycle: the declarative contributions (characterPacks / skills /
 * subagents / agentTeamTemplates / workflowTemplates) ride the manifest and
 * are registered by the plugin manager's overlay dispatch on enable — the
 * plugin never registers them a second time. Only the two workflow nodes are
 * registered imperatively, because a node executor carries a runtime
 * `execute` fn that the manifest can't hold.
 */

import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { REFACTOR_ROLE_PACK } from "./characters/pack"
import { createAgentTurnNode } from "./nodes/agent-turn"
import { createPipelineStopNode } from "./nodes/stop"
import { REFACTOR_SKILLS } from "./skills/definitions"
import { REFACTOR_SUBAGENTS } from "./subagents/definitions"
import { REVIEW_BOARD_TEMPLATE } from "./team/template"
import { REFACTOR_PIPELINE_TEMPLATE } from "./workflow/template"

export const manifest = definePluginManifest({
  ...manifestJson,
  characterPacks: [REFACTOR_ROLE_PACK],
  skills: REFACTOR_SKILLS,
  subagents: REFACTOR_SUBAGENTS,
  agentTeamTemplates: [REVIEW_BOARD_TEMPLATE],
  workflowTemplates: [REFACTOR_PIPELINE_TEMPLATE],
})

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    // Registered through the first-class plugin node API (auto-prefixes the
    // kind, adds the editor palette entry). The disposers go on the
    // activation's lifecycle ledger; the manager also tears a plugin's nodes
    // down on disable.
    ctx.lifecycle.onDispose(
      ctx.workflow.registerNode(
        createAgentTurnNode({
          tauri: ctx.capabilities.tauri,
          runCharacterTurn: ctx.agent.runCharacterTurn,
        })
      ),
      "cognia-backend-refactor:agent-turn-node"
    )
    ctx.lifecycle.onDispose(
      ctx.workflow.registerNode(createPipelineStopNode()),
      "cognia-backend-refactor:pipeline-stop-node"
    )
    // The node catalog entries only exist after the lines above, so the
    // workflow-template `requires.pluginNodeKinds` check can lag depending on
    // enable-order. Refresh now so the pipeline template's warning reflects
    // the just-registered nodes regardless of dispatch order.
    ctx.workflow.refreshTemplateWarnings()
  },
})
