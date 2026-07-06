import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspaceTrustGate } from "./workspace-trust-gate"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

// Workspace Trust surface for the conversation: a Restricted-Mode banner plus a
// lazily-triggered trust dialog. Restricted state is derived from the active
// project's untrusted roots — and it is never restricted on Web, so the stories
// fake the Tauri runtime marker and seed an untrusted project.
const TAURI_MARKER = "__TAURI_INTERNALS__"

const project = (roots: string[]): Project =>
  ({
    id: "proj-1",
    name: "cognia-next",
    roots: roots.map((path, i) => ({ id: `root-${i}`, path, isPrimary: i === 0 })),
  }) as Project

const seed = (roots: string[]) => () => {
  ;(window as unknown as Record<string, unknown>)[TAURI_MARKER] = {}
  resetStore(useProjectStore)
  seedStore(useProjectStore, {
    projects: [project(roots)],
    activeProjectId: "proj-1",
    loaded: true,
  })
  return () => {
    delete (window as unknown as Record<string, unknown>)[TAURI_MARKER]
  }
}

const meta = {
  title: "Chat/WorkspaceTrustGate",
  component: WorkspaceTrustGate,
  parameters: { layout: "fullscreen" },
  args: { sessionId: "demo-session", promptNonce: 0 },
  beforeEach: seed(["/Users/dev/projects/cognia-next"]),
} satisfies Meta<typeof WorkspaceTrustGate>

export default meta
type Story = StoryObj<typeof meta>

/** Restricted workspace → the persistent trust banner. */
export const RestrictedBanner: Story = {}

/** Multiple untrusted roots are all listed in the banner. */
export const MultipleRoots: Story = {
  beforeEach: seed(["/Users/dev/projects/cognia-next", "/Users/dev/projects/shared-lib"]),
}
