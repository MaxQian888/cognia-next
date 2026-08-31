/**
 * Backend Refactor Suite — entry point.
 *
 * A first-party plugin that packages a reusable backend-refactoring
 * development system out of cognia-next's own features:
 *  - **role characters** (character-pack) — analyst / architect / refactorer /
 *    tester / reviewer / doc-writer.
 *  - **agent.turn** (custom workflow node) — a synchronous, tool-enabled,
 *    cwd-scoped Claude turn (the only path that actually edits code; reuses
 *    `runAndCaptureAssistantReply`). Registered via `ctx.workflow.registerNode`.
 *  - **skills**, **subagents**, a **review-board team template**, and the
 *    **backend-refactor-pipeline** workflow template (added across M3/M4).
 *
 * Lifecycle: declarative manifest entries (characterPacks / skills / subagents
 * / agentTeamTemplates / workflowTemplates) are picked up by the plugin
 * manager's OVERLAY_REGISTRY dispatch loop on enable. We additionally register
 * the character pack imperatively here for dev hot-reload coherence (mirrors
 * `cognia-character-seeds`), and the custom workflow node imperatively because
 * node executors carry a runtime `execute` fn that the manifest can't hold.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { PLUGIN_ID } from "./ids"
import { I18N_MESSAGES } from "./i18n"
import { REFACTOR_ROLE_PACK } from "./characters/pack"
import { createAgentTurnNode } from "./nodes/agent-turn"
import { REFACTOR_SKILLS } from "./skills/definitions"
import { REFACTOR_SUBAGENTS } from "./subagents/definitions"
import { REVIEW_BOARD_TEMPLATE } from "./team/template"
import { REFACTOR_PIPELINE_TEMPLATE } from "./workflow/template"
/**
 * Disposer for the custom workflow node. The plugin manager also tears down
 * a plugin's node registrations on disable (`teardownPluginWorkflowRegistrations`),
 * so calling this in deactivate is belt-and-suspenders — it stays correct
 * under dev hot-reload where the manager teardown may not run.
 */
let disposeAgentTurn: (() => void) | null = null

const definition: PluginDefinition = {
  manifest: {
    id: PLUGIN_ID,
    name: "Backend Refactor Suite",
    version: "0.1.0",
    type: "frontend",
    capabilities: [
      "character-pack",
      "workflow",
      "skills",
      "subagent",
      "agent-team-template",
      "workflow-template",
    ],
    main: "src/index.ts",
    permissions: ["agent:control"],
    characterPacks: [REFACTOR_ROLE_PACK],
    skills: REFACTOR_SKILLS,
    subagents: REFACTOR_SUBAGENTS,
    agentTeamTemplates: [REVIEW_BOARD_TEMPLATE],
    workflowTemplates: [REFACTOR_PIPELINE_TEMPLATE],
    i18n: { locales: I18N_MESSAGES },
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("backend-refactor plugin activated")
    // Imperative registration mirrors the declarative manifest so the pack
    // is present under dev hot-reload before the manifest walker runs.
    ctx.characterPacks.register(REFACTOR_ROLE_PACK)
    // The agent.turn node carries a runtime `execute`, so it can't ride the
    // declarative manifest path — register it through the first-class plugin
    // node API (auto-prefixes the kind, adds the editor palette entry).
    disposeAgentTurn = ctx.workflow.registerNode(
      createAgentTurnNode({
        tauri: ctx.capabilities.tauri,
        runCharacterTurn: ctx.agent.runCharacterTurn,
      })
    )
    // The agent.turn catalog entry only exists after the line above, so the
    // workflow-template `requires.pluginNodeKinds` check can lag depending on
    // enable-order. Refresh now so the pipeline template's warning reflects
    // the just-registered node regardless of dispatch order.
    ctx.workflow.refreshTemplateWarnings()
  },
  deactivate: async () => {
    disposeAgentTurn?.()
    disposeAgentTurn = null
  },
}

export default definition
