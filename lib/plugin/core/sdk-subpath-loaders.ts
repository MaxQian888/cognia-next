/**
 * Host loaders for every published `@cognia/plugin-sdk/<subpath>`.
 *
 * An installed plugin bundle leaves these subpaths external (`cognia plugin
 * build` and the browser-builtin bundler both mark `@cognia/plugin-sdk/*`
 * external), so `require()` inside the evaluated bundle must hand back the
 * HOST's module instance. Most subpaths are not pure: `api/skill`,
 * `api/i18n`, `api/character-pack`, `api/tool-renderer` and friends export
 * registry mutators, and a copy inlined into a bundle registers into a private
 * Map the host never reads — the contribution silently does not exist.
 *
 * Kept in lockstep with `packages/plugin-sdk/package.json#exports` by
 * `sdk-subpath-loaders.test.ts`. Each entry is a static `import()` so the
 * host bundler emits one lazy chunk per subpath; the loader primes only the
 * subpaths a bundle actually references (`sharedModulesReferencedBy`).
 */

export const PLUGIN_SDK_SUBPATH_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  "@cognia/plugin-sdk/api/abort": () => import("@cognia/plugin-sdk/api/abort"),
  "@cognia/plugin-sdk/api/agent-team-template": () =>
    import("@cognia/plugin-sdk/api/agent-team-template"),
  "@cognia/plugin-sdk/api/agent-turn": () => import("@cognia/plugin-sdk/api/agent-turn"),
  "@cognia/plugin-sdk/api/automation": () => import("@cognia/plugin-sdk/api/automation"),
  "@cognia/plugin-sdk/api/balance-adapter": () => import("@cognia/plugin-sdk/api/balance-adapter"),
  "@cognia/plugin-sdk/api/bot": () => import("@cognia/plugin-sdk/api/bot"),
  "@cognia/plugin-sdk/api/browser": () => import("@cognia/plugin-sdk/api/browser"),
  "@cognia/plugin-sdk/api/character-pack": () => import("@cognia/plugin-sdk/api/character-pack"),
  "@cognia/plugin-sdk/api/cli-tool": () => import("@cognia/plugin-sdk/api/cli-tool"),
  "@cognia/plugin-sdk/api/commands": () => import("@cognia/plugin-sdk/api/commands"),
  "@cognia/plugin-sdk/api/connector": () => import("@cognia/plugin-sdk/api/connector"),
  "@cognia/plugin-sdk/api/context-panel": () => import("@cognia/plugin-sdk/api/context-panel"),
  "@cognia/plugin-sdk/api/context-provider": () =>
    import("@cognia/plugin-sdk/api/context-provider"),
  "@cognia/plugin-sdk/api/decision-provider": () =>
    import("@cognia/plugin-sdk/api/decision-provider"),
  "@cognia/plugin-sdk/api/download": () => import("@cognia/plugin-sdk/api/download"),
  "@cognia/plugin-sdk/api/editor": () => import("@cognia/plugin-sdk/api/editor"),
  "@cognia/plugin-sdk/api/effort-surface": () => import("@cognia/plugin-sdk/api/effort-surface"),
  "@cognia/plugin-sdk/api/eval": () => import("@cognia/plugin-sdk/api/eval"),
  "@cognia/plugin-sdk/api/external-agent-adapter": () =>
    import("@cognia/plugin-sdk/api/external-agent-adapter"),
  "@cognia/plugin-sdk/api/external-agent-preset": () =>
    import("@cognia/plugin-sdk/api/external-agent-preset"),
  "@cognia/plugin-sdk/api/host-environment": () =>
    import("@cognia/plugin-sdk/api/host-environment"),
  "@cognia/plugin-sdk/api/i18n": () => import("@cognia/plugin-sdk/api/i18n"),
  "@cognia/plugin-sdk/api/integration": () => import("@cognia/plugin-sdk/api/integration"),
  "@cognia/plugin-sdk/api/issues": () => import("@cognia/plugin-sdk/api/issues"),
  "@cognia/plugin-sdk/api/message-renderer": () =>
    import("@cognia/plugin-sdk/api/message-renderer"),
  "@cognia/plugin-sdk/api/native-anthropic-tool": () =>
    import("@cognia/plugin-sdk/api/native-anthropic-tool"),
  "@cognia/plugin-sdk/api/ocr-provider": () => import("@cognia/plugin-sdk/api/ocr-provider"),
  "@cognia/plugin-sdk/api/resources": () => import("@cognia/plugin-sdk/api/resources"),
  "@cognia/plugin-sdk/api/sandbox": () => import("@cognia/plugin-sdk/api/sandbox"),
  "@cognia/plugin-sdk/api/scheduled-task": () => import("@cognia/plugin-sdk/api/scheduled-task"),
  "@cognia/plugin-sdk/api/security-findings": () =>
    import("@cognia/plugin-sdk/api/security-findings"),
  "@cognia/plugin-sdk/api/shared-memory-adapter": () =>
    import("@cognia/plugin-sdk/api/shared-memory-adapter"),
  "@cognia/plugin-sdk/api/site": () => import("@cognia/plugin-sdk/api/site"),
  "@cognia/plugin-sdk/api/skill": () => import("@cognia/plugin-sdk/api/skill"),
  "@cognia/plugin-sdk/api/skill-recorder": () => import("@cognia/plugin-sdk/api/skill-recorder"),
  "@cognia/plugin-sdk/api/slash-command": () => import("@cognia/plugin-sdk/api/slash-command"),
  "@cognia/plugin-sdk/api/subagent": () => import("@cognia/plugin-sdk/api/subagent"),
  "@cognia/plugin-sdk/api/team": () => import("@cognia/plugin-sdk/api/team"),
  "@cognia/plugin-sdk/api/tool": () => import("@cognia/plugin-sdk/api/tool"),
  "@cognia/plugin-sdk/api/tool-renderer": () => import("@cognia/plugin-sdk/api/tool-renderer"),
  "@cognia/plugin-sdk/api/webview": () => import("@cognia/plugin-sdk/api/webview"),
  "@cognia/plugin-sdk/api/workflow-editor": () => import("@cognia/plugin-sdk/api/workflow-editor"),
  "@cognia/plugin-sdk/api/workflow-run": () => import("@cognia/plugin-sdk/api/workflow-run"),
  "@cognia/plugin-sdk/api/workflow-template": () =>
    import("@cognia/plugin-sdk/api/workflow-template"),
  "@cognia/plugin-sdk/context": () => import("@cognia/plugin-sdk/context"),
  "@cognia/plugin-sdk/contracts": () => import("@cognia/plugin-sdk/contracts"),
  "@cognia/plugin-sdk/events": () => import("@cognia/plugin-sdk/events"),
  "@cognia/plugin-sdk/extensions": () => import("@cognia/plugin-sdk/extensions"),
  "@cognia/plugin-sdk/hooks": () => import("@cognia/plugin-sdk/hooks"),
  "@cognia/plugin-sdk/manifest": () => import("@cognia/plugin-sdk/manifest"),
  "@cognia/plugin-sdk/permissions": () => import("@cognia/plugin-sdk/permissions"),
  "@cognia/plugin-sdk/templates": () => import("@cognia/plugin-sdk/templates"),
}
