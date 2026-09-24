import type { Meta, StoryObj } from "@storybook/nextjs"
import { useCallback, useMemo, type ReactNode } from "react"

import {
  ProjectEditorFileWorkbench,
  useProjectEditorWorkbench,
  type ProjectEditorWorkbenchLayout,
} from "./project-editor-workbench"
import { createMockWorkspace, type MockWorkspace } from "@/lib/storybook/fixtures/project-workspace"
import { Toaster } from "@/components/ui/sonner"

// The dock's file editor, mounted standalone over an in-memory workspace.
// Everything inside the frame is production code — the workbench hook, the
// per-group tab strips, Monaco (or CodeMirror on the phone layout), the
// explorer, search, quick open, the Problems panel and the file context
// workbench — against a Map-backed filesystem whose writes emit real watcher
// events. The strip above the editor performs those writes the way an agent's
// file tool would, so the external-change paths (silent reload of a clean
// buffer, the conflict banner over a dirty one, the deleted-on-disk banner)
// can be exercised without a desktop host.

function AgentActions({
  workspace,
  rootPath,
  activeRelPath,
}: {
  workspace: MockWorkspace
  rootPath: string
  activeRelPath: string | null
}) {
  const deps = workspace.deps
  const run = useCallback(
    (action: (relPath: string) => Promise<void>) => {
      if (activeRelPath) void action(activeRelPath)
    },
    [activeRelPath]
  )
  const actions: Array<[string, () => void]> = [
    [
      "Agent edits the active file",
      () =>
        run(async (relPath) => {
          const disk = await deps.readFile!(rootPath, relPath).catch(() => "")
          await deps.writeFile!(rootPath, relPath, `${disk}\n// edited by the agent\n`)
        }),
    ],
    [
      "Agent deletes the active file",
      () => run((relPath) => deps.deleteEntry!(rootPath, relPath, false)),
    ],
    [
      "Agent recreates the active file",
      () => run((relPath) => deps.writeFile!(rootPath, relPath, "// recreated by the agent\n")),
    ],
  ]
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-muted/30 px-2 py-1 text-[11px]">
      {actions.map(([label, onClick]) => (
        <button
          key={label}
          type="button"
          disabled={!activeRelPath}
          className="h-6 rounded border bg-background px-2 hover:bg-accent disabled:opacity-50"
          onClick={onClick}
        >
          {label}
        </button>
      ))}
      <span className="text-muted-foreground">
        Dirty a file first, then let the agent edit it to see the conflict banner.
      </span>
    </div>
  )
}

function WorkbenchStory({ layout }: { layout: ProjectEditorWorkbenchLayout }) {
  const workspace = useMemo(() => createMockWorkspace(), [])
  const workbench = useProjectEditorWorkbench({
    scopeKey: `storybook:project-editor:${layout}`,
    workingDir: workspace.root,
    followedRoot: null,
    registerProjectOpener: false,
    deps: workspace.deps,
    layout,
  })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentActions
        workspace={workspace}
        rootPath={workbench.editor.rootPath}
        activeRelPath={workbench.editor.activePath}
      />
      <div className="min-h-0 flex-1" onKeyDown={workbench.onKeyDown}>
        <ProjectEditorFileWorkbench
          workbench={workbench}
          panelIdPrefix={`storybook-${layout}`}
          gitDeps={workspace.gitDeps}
          searchDeps={workspace.searchDeps}
          quickOpenDeps={workspace.quickOpenDeps}
        />
      </div>
      <Toaster />
    </div>
  )
}

function Frame({ children, width }: { children: ReactNode; width?: number }) {
  return (
    <div className="h-[640px] border bg-background" style={width ? { width } : undefined}>
      {children}
    </div>
  )
}

const meta = {
  title: "Editor/Project Editor Workbench",
  component: WorkbenchStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkbenchStory>

export default meta
type Story = StoryObj<typeof meta>

// Widths are the dock's own, minus its 48px activity rail: the editor never
// gets a window to itself — it lives in the chat's right dock, which runs from
// a 480px floor to 65% of the chat workspace.

// The dock at its 65% "wide" preset on a 1440px screen: room for the explorer,
// the editor and the file context workbench side by side.
export const DockWide: Story = {
  args: { layout: "split" },
  decorators: [
    (Story) => (
      <Frame width={880}>
        <Story />
      </Frame>
    ),
  ],
}

// The dock at its 45% "narrow" preset on a 1280px laptop. Too narrow for both
// sidebars: opening the context workbench folds the explorer to its rail and
// reopening the explorer folds the context workbench. The status bar and the
// Problems header shed their low-priority items.
export const DockDefault: Story = {
  args: { layout: "split" },
  decorators: [
    (Story) => (
      <Frame width={528}>
        <Story />
      </Frame>
    ),
  ],
}

// The dock at its 480px floor.
export const DockFloor: Story = {
  args: { layout: "split" },
  decorators: [
    (Story) => (
      <Frame width={432}>
        <Story />
      </Frame>
    ),
  ],
}

// The phone pane flow: Files / Search / Editor behind a bottom nav, a touch
// tab strip over CodeMirror, and the context workbench as a drawer.
export const Mobile: Story = {
  args: { layout: "mobile" },
  decorators: [
    (Story) => (
      <Frame width={390}>
        <Story />
      </Frame>
    ),
  ],
}
