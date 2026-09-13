import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"

import { WorkspaceManageDialog } from "./workspace-manage-dialog"
import { useProjectStore } from "@/stores/project/project-store"

// Create / edit / delete workspaces (master-detail). Reads the project store;
// with no projects the list is empty and the editor shows its "select a
// workspace" hint. Rendered open so the dialog content is visible.
const meta = {
  title: "Shell/WorkspaceManageDialog",
  component: WorkspaceManageDialog,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof WorkspaceManageDialog>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Seeds through the store's own `createProject` rather than hand-building
 * `Project` literals: the derived `rootDir` / `additionalDirs` mirrors are the
 * store's job, and a story that fills them in by hand is a second, silently
 * drifting copy of that rule.
 */
function seed(entries: Array<{ name: string; roots: string[] }>) {
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: true })
  const { createProject } = useProjectStore.getState()
  const created = entries.map(({ name, roots }) =>
    createProject({
      name,
      roots: roots.map((path, index) => ({
        id: `${name}-root-${index}`,
        path,
        label: path.split("/").filter(Boolean).at(-1) ?? path,
      })),
    })
  )
  if (created[0]) useProjectStore.setState({ activeProjectId: created[0].id })
  return created
}

const THREE = [
  { name: "Cognia", roots: ["/Users/dev/repos/cognia", "/Users/dev/repos/cognia-docs"] },
  { name: "Marketing site", roots: ["/Users/dev/repos/web"] },
  { name: "Sandbox", roots: ["/Users/dev/scratch"] },
]

/** The roster with nothing picked yet — the editor states what to do. */
export const Open: Story = {
  decorators: [
    (Story) => {
      seed(THREE)
      return <Story />
    },
  ],
}

/** The editor itself: name, folders with their trust toggles, knowledge base. */
export const Editing: Story = {
  decorators: [
    (Story) => {
      seed(THREE)
      return <Story />
    },
  ],
  play: async ({ canvasElement }) => {
    // The dialog is portalled, so the canvas is the body rather than the root.
    const body = within(canvasElement.ownerDocument.body)
    const rows = await body.findAllByText("Cognia")
    await userEvent.click(rows[0])
    await expect(body.getByLabelText(/name/i)).toBeInTheDocument()
  },
}

/** Past the filter threshold, where the roster earns its search field. */
export const ManyWorkspaces: Story = {
  decorators: [
    (Story) => {
      seed(
        Array.from({ length: 9 }, (_, index) => ({
          name: `Workspace ${index + 1}`,
          roots: [`/Users/dev/repos/project-${index + 1}`],
        }))
      )
      return <Story />
    },
  ],
}

/** Empty roster: the list offers creation and the editor explains itself. */
export const NoWorkspaces: Story = {
  decorators: [
    (Story) => {
      useProjectStore.setState({ projects: [], activeProjectId: null, loaded: true })
      return <Story />
    },
  ],
}
