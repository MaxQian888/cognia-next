/** @jest-environment node */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const root = process.cwd()

// Follow only the route-owned graph. Shared feature dependencies remain valid
// mobile dependencies; the emitted production graph is checked separately.
function mobileRouteImports(route: string): Set<string> {
  const imports = new Set<string>()
  const visited = new Set<string>()
  function visit(file: string) {
    if (visited.has(file)) return
    visited.add(file)
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    )
    function record(specifier: string) {
      imports.add(specifier)
      const base = specifier.startsWith("@/app/")
        ? path.join(root, specifier.slice(2))
        : specifier.startsWith(".")
          ? path.resolve(path.dirname(file), specifier)
          : null
      if (!base || !base.startsWith(path.join(root, "app") + path.sep)) return
      const resolved = [".mobile.tsx", ".mobile.ts", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find(existsSync)
      if (resolved) visit(resolved)
    }
    function walk(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        ts.isExportDeclaration(node)
      ) {
        if (
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          !(ts.isExportDeclaration(node) && node.isTypeOnly)
        ) {
          record(node.moduleSpecifier.text)
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        record(node.arguments[0].text)
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
  }
  visit(path.join(root, "app", route, "page.tsx"))
  return imports
}

const bodyCases = [
  ["agents", "@/components/agents/agents-console", "@/components/mobile/agents/agents-mobile-body"],
  ["inbox/all", "@/components/inbox/inbox-shell", "@/components/mobile/inbox/mobile-inbox-body"],
  ["", "@/components/desktop/desktop-chat-workspace", "@/components/app-shell-mobile"],
  ["bots", "@/components/bots/bot-console", "@/components/mobile/bots/bots-mobile-body"],
  [
    "devices",
    "@/components/devices/device-console",
    "@/components/mobile/devices/devices-mobile-body",
  ],
  [
    "discover",
    "@/components/discover/discover-desktop-body",
    "@/components/mobile/discover/discover-mobile-body",
  ],
  [
    "goals",
    "@/components/goal/console/goal-console",
    "@/components/mobile/goals/goals-mobile-body",
  ],
  ["issues", "@/components/issues/issue-console", "@/components/mobile/issues/issues-mobile-body"],
  ["memory", "@/components/memory/memory-console", "@/components/mobile/memory/memory-mobile-body"],
  ["plugins", "@/components/plugins", "@/components/mobile/plugins/plugins-mobile-body"],
  [
    "projects",
    "@/components/issues/projects/project-console",
    "@/components/mobile/issues/projects-mobile-body",
  ],
  [
    "source-control",
    "@/components/source-control/source-control-panel",
    "@/components/mobile/source-control/source-control-mobile-body",
  ],
  [
    "squads",
    "@/components/squads/squad-fleet-console",
    "@/components/mobile/squads/squads-mobile-body",
  ],
  [
    "templates",
    "@/components/templates/template-studio",
    "@/components/mobile/templates/templates-mobile-body",
  ],
  [
    "workflows",
    "@/components/workflow/library/workflow-library",
    "@/components/mobile/workflow/workflow-list",
  ],
  [
    "workflows/editor",
    "@/components/workflow/editor/canvas",
    "@/components/mobile/workflow/editor/mobile-workflow-editor",
  ],
  [
    "workflows/runs",
    "@/components/workflow/runs/run-list",
    "@/components/mobile/workflow/mobile-runs-list",
  ],
  [
    "inbox/drafts",
    "@/components/inbox/draft-center",
    "@/components/mobile/inbox/mobile-inbox-body",
  ],
  [
    "servers",
    "@/components/feature-shell/feature-page-shell",
    "@/components/mobile/servers/servers-mobile-body",
  ],
  [
    "servers/detail",
    "@/components/feature-shell/feature-page-shell",
    "@/components/mobile/servers/server-detail-mobile-body",
  ],
] as const

it.each(bodyCases)(
  "/%s keeps its mobile body without the wide route entry",
  (route, desktop, mobile) => {
    const imports = mobileRouteImports(route)
    expect(imports).toContain(mobile)
    expect(imports).not.toContain(desktop)
  }
)

const windows = {
  "pet-overlay": "@/components/pet/pet-overlay-view",
  "pet-popup": "@/components/pet/pet-popup-view",
  island: "@/components/fleet/island-view",
  "selection-toolbar": "@/components/selection-toolbar/selection-toolbar-view",
  "tray-panel": "@/components/tray-panel/tray-panel-view",
  "recorder-controller": "@/components/skills/recorder/recorder-controller-view",
  "usage-dock": "@/components/usage-dock/usage-dock-view",
  "chat-copilot": "@/components/reply-copilot/screen/chat-copilot-overlay",
}

it.each(Object.entries(windows))(
  "/%s retains a mobile route without its desktop window implementation",
  (route, desktop) => {
    const imports = mobileRouteImports(route)
    expect(imports).not.toContain(desktop)
    expect(imports).toContain("@/app/_platform/desktop-window-message")
  }
)

it("/scheduler mobile entry preserves the route without importing the wide scheduler", () => {
  expect(mobileRouteImports("scheduler")).not.toContain(
    "@/components/scheduler/overview/scheduler-overview"
  )
})
