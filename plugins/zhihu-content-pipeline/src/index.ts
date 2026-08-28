/**
 * Zhihu Content Pipeline — entry point.
 *
 * A pluggable, first-party plugin that packages a Zhihu content-creation
 * system out of cognia-next's own features:
 *  - **role characters** (character-pack) — scout / editor / researcher /
 *    writer / polisher, each carrying its playbook skill.
 *  - **skills** — inline Zhihu writing / research / de-AI / illustration
 *    playbooks adapted from the matching skills in skills-test.
 *  - **MCP presets** — zget (bundled wrapper), Exa, Fetch, Sequential
 *    Thinking, and a CloakBrowser-backed Playwright preset.
 *  - **Dexie tables** — topics / research / drafts (the pipeline's products).
 *  - **plugin tools** — zhihu_save_research / zhihu_save_draft (how the
 *    writing crew persists, since agents can't reach `ctx.dexie`).
 *  - **custom node** — save-topics (front workflow's terminal step).
 *  - **workflow template** — 知乎选题候选 (热点 → 打分 → 候选入库).
 *  - **agent-team template** — 知乎写作小组 (调研 → 写作 → 配图 → 终稿).
 *
 * Lifecycle (mirrors `cognia-backend-refactor`): declarative manifest entries
 * (characterPacks / skills / mcpServerPresets / dexie / workflowTemplates /
 * agentTeamTemplates / i18n) ride the plugin manager's OVERLAY_REGISTRY
 * dispatch on enable. We additionally register imperatively the pieces that
 * need runtime values: the character pack (dev hot-reload coherence), the zget
 * MCP preset (needs `ctx.pluginPath`), and the persist tools + save-topics node
 * (both close over the `ctx.dexie` handle, which the manifest can't hold).
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import {
  registerCharacterPack,
  unregisterCharacterPacksByPlugin,
} from "@cognia/plugin-sdk/api/character-pack"
import { refreshAllWorkflowTemplateWarnings } from "@cognia/plugin-sdk/api/workflow-template"
import { I18N_MESSAGES } from "./i18n"
import { ZHIHU_ROLE_PACK } from "./characters/pack"
import { ZHIHU_SKILLS } from "./skills/definitions"
import { STATIC_MCP_PRESETS } from "./mcp/presets"
import { makePersistTools } from "./tools/persist"
import { makeSaveTopicsNode } from "./nodes/save-topics"
import { TOPIC_DISCOVERY_TEMPLATE } from "./workflow/template"
import { WRITING_CREW_TEMPLATE } from "./team/template"
import { setPipelineDbFromDexie } from "./db/runtime"
import { handleZhihuCommand } from "./commands"
import manifestJson from "../plugin.json"

/** Disposer for the imperatively-registered save-topics node. */
let disposeSaveTopics: (() => void) | null = null

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
    characterPacks: [ZHIHU_ROLE_PACK],
    skills: ZHIHU_SKILLS,
    mcpServerPresets: STATIC_MCP_PRESETS,
    workflowTemplates: [TOPIC_DISCOVERY_TEMPLATE],
    agentTeamTemplates: [WRITING_CREW_TEMPLATE],
    dexie: {
      tables: [
        { name: "topics", schema: "&id, status, createdAt" },
        { name: "research", schema: "&id, topicId, createdAt" },
        { name: "drafts", schema: "&id, topicId, status, createdAt" },
      ],
    },
    i18n: { locales: I18N_MESSAGES },
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("zhihu-content-pipeline plugin activated")
    // Imperative registration mirrors the declarative manifest so the pack is
    // present under dev hot-reload before the manifest walker runs. The MCP
    // presets ride the declarative manifest (all npx/uvx-spawnable); zget is
    // not a preset — roles run it via Bash, the workflow via a terminal node.
    registerCharacterPack(ZHIHU_ROLE_PACK.id, ZHIHU_ROLE_PACK, { pluginId: ctx.pluginId })

    // The persist tools and the save-topics node both need the live Dexie
    // handle (agents/nodes can't reach `ctx.dexie` themselves), so they're
    // built here and registered imperatively. Publishing the handle to the
    // runtime singleton also lets the review modal read the tables. Without
    // dexie the pack/skills/presets/templates still work.
    setPipelineDbFromDexie(ctx.dexie)
    if (ctx.dexie) {
      for (const tool of makePersistTools(ctx.dexie)) {
        ctx.agent.registerTool(tool)
      }
      disposeSaveTopics = ctx.workflow.registerNode(makeSaveTopicsNode(ctx.dexie))
      // The save-topics catalog entry only exists after the line above, so the
      // workflow template's `requires.pluginNodeKinds` warning can lag on
      // enable-order. Refresh now so the template reflects the just-registered
      // node regardless of dispatch order.
      refreshAllWorkflowTemplateWarnings()
    } else {
      ctx.logger?.warn(
        "zhihu-content-pipeline: no Dexie handle — persistence (save-topics node, save tools) disabled"
      )
    }
    // The `/zhihu` slash command opens the review modal (the verified-rendered
    // UI surface). Registered last so the modal's deps are wired.
    // `/zhihu` is DECLARED in plugin.json (`commands[]`) and handled here.
    return {
      onCommand: async (command: string) => {
        const message = handleZhihuCommand(ctx, command)
        if (message === null) return false
        ctx.ui?.showToast?.(message, "info")
        return true
      },
    }
  },
  deactivate: async (ctx?: PluginContext) => {
    disposeSaveTopics?.()
    disposeSaveTopics = null
    setPipelineDbFromDexie(null)
    if (ctx?.pluginId) {
      unregisterCharacterPacksByPlugin(ctx.pluginId)
    }
  },
}

export default definition
