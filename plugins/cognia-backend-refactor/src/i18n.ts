/**
 * Declarative i18n bundle (ADR-0026 §5 §D). The plugin manager auto-wires
 * `manifest.i18n.locales` on enable and tears it down on disable; keys are
 * resolved as `plugin.<pluginId>.<key>` at render time. Plugin bundles do NOT
 * touch `i18n/messages/{en,zh-CN}.json`, so the host `lint:i18n` baseline is
 * unaffected.
 *
 * Pack / role / template display names are plain strings on their defs (the
 * consuming pickers read those fields directly, not i18n keys) — matching the
 * first-party `cognia-character-seeds` / `computer-use` convention. This
 * bundle covers the plugin-owned status text only.
 */

export const I18N_MESSAGES = {
  en: {
    "plugin.cognia-backend-refactor.activated":
      "Backend Refactor suite registered: role characters, the agent.turn node, skills, a review-board team, and the backend-refactor-pipeline workflow template. Point a role's working directory at a repo clone and run the template.",
  },
  "zh-CN": {
    "plugin.cognia-backend-refactor.activated":
      "后端重构套件已注册：角色 characters、agent.turn 节点、skills、评审团队，以及 backend-refactor-pipeline 工作流模板。把某个角色的工作目录指向仓库克隆即可运行该模板。",
  },
} as const
