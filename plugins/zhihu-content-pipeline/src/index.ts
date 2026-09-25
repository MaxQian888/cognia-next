/**
 * Zhihu Content Pipeline — entry point.
 *
 * A pluggable, first-party plugin that packages a Zhihu content-creation
 * system out of cognia-next's own features:
 *  - **role characters** (character-pack) — scout / editor / researcher /
 *    writer / polisher, each carrying its playbook skill.
 *  - **skills** — inline Zhihu writing / research / de-AI / illustration
 *    playbooks adapted from the matching skills in skills-test.
 *  - **MCP presets** — Exa, Fetch, Sequential Thinking, and a
 *    CloakBrowser-backed Playwright preset. zget is NOT a preset: it has no
 *    MCP server, so the roles run the external `zget` CLI through Bash and the
 *    topic workflow runs it from a terminal node (`requires.binaries`).
 *  - **Dexie tables** — topics / research / drafts (the pipeline's products).
 *  - **plugin tools** — zhihu_save_research / zhihu_save_draft (how the
 *    writing crew persists, since agents can't reach `ctx.dexie`). The same
 *    defs are declared on `manifest.tools` so they're discoverable before
 *    activation; `activate()` registers the executable halves.
 *  - **custom node** — save-topics (front workflow's terminal step).
 *  - **workflow template** — 知乎选题候选 (热点 → 打分 → 候选入库).
 *  - **agent-team template** — 知乎写作小组 (调研 → 写作 → 配图 → 终稿).
 *
 * Lifecycle: `dexie`, `tools`, `commands` and the i18n bundle are plain data
 * in plugin.json; `characterPacks` / `skills` / `mcpServerPresets` /
 * templates are authored in TypeScript and merged over it below. The manager
 * registers all of them on enable (OVERLAY_REGISTRY dispatch, Dexie and i18n
 * enable steps). `activate()` additionally registers what needs runtime
 * values: the character pack (dev hot-reload coherence), and the persist tools
 * + save-topics node, which close over the `ctx.dexie` handle.
 *
 * `workflowTemplates` / `agentTeamTemplates` stay on the legacy manifest
 * fields ON PURPOSE: the workflow editor's plugin-capabilities section and the
 * team-template picker still read the overlay registries those fields feed,
 * while `templatePackages` / `ctx.templates.register` only feed the ADR-0100
 * template catalog. The compat path already projects both into the catalog,
 * so migrating today would hide the templates from the pickers users see. The
 * deprecation diagnostic is acknowledged and tracked as a platform follow-up.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import { ZHIHU_ROLE_PACK } from "./characters/pack"
import { ZHIHU_SKILLS } from "./skills/definitions"
import { STATIC_MCP_PRESETS } from "./mcp/presets"
import { makePersistTools } from "./tools/persist"
import { makeSaveTopicsNode } from "./nodes/save-topics"
import { TOPIC_DISCOVERY_TEMPLATE } from "./workflow/template"
import { WRITING_CREW_TEMPLATE } from "./team/template"
import { setPipelineDbFromDexie, setReviewHost } from "./db/runtime"
import { handleZhihuCommand } from "./commands"
import manifestJson from "../plugin.json"

/** Disposers for everything `activate()` registers imperatively. */
const activateDisposers: Array<() => void> = []

function runDisposers(): void {
  for (const dispose of activateDisposers.splice(0)) {
    try {
      dispose()
    } catch {
      // best-effort cleanup — a failed release must not wedge deactivate
    }
  }
}

// Spread plugin.json via `definePluginManifest`: `builtinManifest()` merges
// module-over-JSON, so a hand-written subset here WINS and would silently drop
// `commands[]` / `tools[]` / `dexie` / `i18n` — while still type-checking the
// added contribution fields (excess keys fail to compile).
export const manifest = definePluginManifest({
  ...manifestJson,
  characterPacks: [ZHIHU_ROLE_PACK],
  skills: ZHIHU_SKILLS,
  mcpServerPresets: STATIC_MCP_PRESETS,
  workflowTemplates: [TOPIC_DISCOVERY_TEMPLATE],
  agentTeamTemplates: [WRITING_CREW_TEMPLATE],
})

const definition = definePlugin({
  manifest,
  activate: async (ctx) => {
    ctx.logger.info("zhihu-content-pipeline plugin activated")
    // Imperative registration mirrors the declarative manifest so the pack is
    // present under dev hot-reload before the manifest walker runs. The MCP
    // presets ride the declarative manifest (all npx/uvx-spawnable); zget is
    // not a preset — roles run it via Bash, the workflow via a terminal node.
    // A re-activate without a matching deactivate (dev hot-reload) must not
    // leak the previous imperative registrations — release them first.
    runDisposers()
    const packRegistration = ctx.characterPacks.register(ZHIHU_ROLE_PACK)
    activateDisposers.push(() => packRegistration.unregister())

    // The persist tools and the save-topics node both need the live Dexie
    // handle (agents/nodes can't reach `ctx.dexie` themselves), so they're
    // built here and registered imperatively. Publishing the handle to the
    // runtime singleton also lets the review modal read the tables. Without
    // dexie the pack/skills/presets/templates still work.
    setPipelineDbFromDexie(ctx.dexie)
    setReviewHost({ session: ctx.session, clipboard: ctx.clipboard, ui: ctx.ui })
    if (ctx.dexie) {
      for (const tool of makePersistTools(ctx.dexie)) {
        activateDisposers.push(ctx.agent.registerTool(tool))
      }
      activateDisposers.push(ctx.workflow.registerNode(makeSaveTopicsNode(ctx.dexie)))
      // The save-topics catalog entry only exists after the line above, so the
      // workflow template's `requires.pluginNodeKinds` warning can lag on
      // enable-order. Refresh now so the template reflects the just-registered
      // node regardless of dispatch order.
      ctx.workflow.refreshTemplateWarnings()
    } else {
      ctx.logger.warn(
        "zhihu-content-pipeline: no Dexie handle — persistence (save-topics node, save tools) disabled"
      )
    }
    // The `/zhihu` slash command opens the review modal (the verified-rendered
    // UI surface). Registered last so the modal's deps are wired.
    // `/zhihu` is DECLARED in plugin.json (`commands[]`) and handled here.
    // The hook returns the handler's PluginCommandResult directly — the
    // localized message lands in the invoking chat as the command's answer.
    return {
      onCommand: async (command: string) => handleZhihuCommand(ctx, command) ?? false,
    }
  },
  deactivate: async () => {
    runDisposers()
    setPipelineDbFromDexie(null)
    setReviewHost(null)
  },
})

export default definition
