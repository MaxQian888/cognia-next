import type { Meta, StoryObj } from "@storybook/nextjs"

import { ArtifactPart } from "./artifact-part"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { Artifact } from "@/types"
import type { ArtifactPart as ArtifactPartType } from "@/lib/claude/parts-extensions"

// `ArtifactPart` reads the LIVE artifact from `useArtifactStore` by id (the
// part carries only a pointer + title snapshot). Each story seeds the store
// directly via `setState` so the inline panel has a real row to render — no
// Dexie / sidecar. The "missing" story seeds nothing, exercising the cleared
// placeholder branch. Document/markdown artifacts render through the builtin
// renderer (no iframe), keeping the static frame deterministic.

const DOC_ID = "artifact-doc-1"
const CODE_ID = "artifact-code-1"

const baseArtifact = (over: Partial<Artifact>): Artifact => ({
  id: "x",
  sessionId: "demo-session",
  messageId: "m1",
  type: "document",
  title: "Untitled",
  content: "",
  version: 1,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
})

const docArtifact = baseArtifact({
  id: DOC_ID,
  type: "document",
  language: "markdown",
  title: "Release checklist",
  content: [
    "## v2.4 release checklist",
    "",
    "- [x] Bump version in `package.json`",
    "- [x] Run `pnpm test:coverage`",
    "- [ ] Tag and push",
    "",
    "> Gate the marketing push behind the tier check.",
  ].join("\n"),
})

const codeArtifact = baseArtifact({
  id: CODE_ID,
  type: "code",
  language: "typescript",
  title: "debounce.ts",
  content: `export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}
`,
})

function seed(...artifacts: Artifact[]) {
  useArtifactStore.setState({
    artifacts: Object.fromEntries(artifacts.map((a) => [a.id, a])),
  })
}

const part = (over: Partial<ArtifactPartType> & { artifactId: string }): ArtifactPartType => ({
  type: "artifact",
  title: "Artifact",
  kind: "document",
  ...over,
})

const meta = {
  title: "Chat/MessageParts/ArtifactPart",
  component: ArtifactPart,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ArtifactPart>

export default meta
type Story = StoryObj<typeof meta>

// Markdown document artifact — expanded panel with the builtin doc renderer.
export const Document: Story = {
  args: {
    part: part({ artifactId: DOC_ID, title: "Release checklist", kind: "document" }),
  },
  beforeEach: () => seed(docArtifact),
}

// Code artifact — collapsed by default (`defaultOpen: false`) so only the
// header + action row shows (copy / download / open-in-canvas / toggle).
export const CodeCollapsed: Story = {
  args: {
    part: part({
      artifactId: CODE_ID,
      title: "debounce.ts",
      kind: "code",
      defaultOpen: false,
    }),
  },
  beforeEach: () => seed(codeArtifact),
}

// The store no longer has the row (cleared / evicted) — the dashed "cleared"
// placeholder renders from the part's title snapshot alone.
export const Cleared: Story = {
  args: {
    part: part({ artifactId: "gone-9", title: "Q3 planning notes", kind: "document" }),
  },
  beforeEach: () => seed(),
}
