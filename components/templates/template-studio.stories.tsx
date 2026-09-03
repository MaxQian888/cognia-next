import type { Meta, StoryObj } from "@storybook/nextjs"

import { TemplateStudio } from "./template-studio"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { templateCatalog } from "@/lib/templates/catalog"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import { useProjectStore } from "@/stores/project/project-store"

// The desktop three-pane template workspace (ADR-0100, scope per ADR-0164):
// a filter rail, the catalog list, and the inspector for the selection. The
// catalog is an in-memory store, so stories seed it directly under a story
// source id. Packages, instances and ownership come from a fresh Dexie.
//
// Selection and filters live in the URL, and Storybook's router mock does not
// round-trip `router.replace`, so the selected stories preselect through the
// navigation parameters rather than by clicking a card.

const STORY_SOURCE = "storybook"
const T0 = Date.UTC(2026, 7, 20, 9, 0, 0)

function envelope(over: Partial<TemplateDefinitionEnvelope>): TemplateDefinitionEnvelope {
  return {
    apiVersion: "cognia.dev/templates/v1",
    id: "user.skill.notes",
    domain: "skill",
    version: null,
    status: "draft",
    revision: 1,
    metadata: { name: "Notes", description: "Take notes" },
    payload: { name: "Notes", content: "" },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
    contentHash: "sha256:notes",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

function makeStudioCatalog(): TemplateDefinitionEnvelope[] {
  return [
    envelope({
      id: "user.skill.release-notes",
      domain: "skill",
      revision: 4,
      metadata: {
        name: "Release notes writer",
        description: "Turns a merged changelog into release notes with a friendly tone.",
        tags: ["writing", "release"],
      },
      payload: { name: "Release notes writer", content: "Summarise {{changelog}} for users." },
      inputs: [{ id: "changelog", label: "Changelog", kind: "string", required: true }],
      contentHash: "sha256:release-notes",
      updatedAt: T0 + 3_600_000,
    }),
    envelope({
      id: "team.parallel-review",
      domain: "agentTeam",
      version: "1.2.0",
      status: "published",
      revision: 3,
      metadata: {
        name: "Parallel review",
        description: "A lead plus three reviewers who each take one slice of a pull request.",
        tags: ["review", "squad"],
        author: "Cognia",
      },
      payload: {
        team: { name: "Parallel review", description: "Three reviewers, one lead" },
        teammates: [
          { name: "Security reviewer", role: "teammate" },
          { name: "Performance reviewer", role: "teammate" },
          { name: "Style reviewer", role: "teammate" },
        ],
      },
      inputs: [
        { id: "repository", label: "Repository", kind: "string", required: true },
        {
          id: "depth",
          label: "Review depth",
          kind: "enum",
          options: ["quick", "thorough"],
          required: false,
          defaultValue: "thorough",
        },
      ],
      capabilities: ["github.read"],
      contentHash: "sha256:parallel-review-1.2.0",
      baselineHash: "sha256:parallel-review-1.2.0",
    }),
    envelope({
      id: "team.parallel-review",
      domain: "agentTeam",
      version: "1.1.0",
      status: "published",
      revision: 2,
      metadata: { name: "Parallel review", description: "Two reviewers and a lead." },
      payload: { team: { name: "Parallel review" } },
      contentHash: "sha256:parallel-review-1.1.0",
      baselineHash: "sha256:parallel-review-1.1.0",
      updatedAt: T0 - 86_400_000,
    }),
    envelope({
      id: "builtin.workflow.daily-digest",
      domain: "workflow",
      version: "2.0.0",
      status: "published",
      revision: 1,
      metadata: {
        name: "Daily digest",
        description: "Collects inbox activity every morning and posts one summary.",
        tags: ["automation"],
      },
      payload: { nodes: [], edges: [] },
      provenance: { source: "built-in", trust: "built-in" },
      contentHash: "sha256:daily-digest",
      baselineHash: "sha256:daily-digest",
    }),
    envelope({
      id: "market.character.support-agent",
      domain: "character",
      version: "0.9.1",
      status: "published",
      revision: 1,
      metadata: {
        name: "Support agent",
        description: "A patient first-line support persona with escalation rules.",
        author: "Acme Publishing",
      },
      payload: { name: "Support agent", persona: "Patient and precise." },
      provenance: {
        source: "marketplace",
        trust: "verified-publisher",
        publisher: "acme",
        packageId: "acme.support-agent",
      },
      contentHash: "sha256:support-agent",
      baselineHash: "sha256:support-agent",
    }),
    envelope({
      id: "user.customMode.deep-research",
      domain: "customMode",
      version: "1.0.0",
      status: "deprecated",
      revision: 5,
      metadata: {
        name: "Deep research",
        description: "Long-horizon research mode. Superseded by the built-in research preset.",
      },
      payload: { name: "Deep research", systemPrompt: "Research thoroughly." },
      contentHash: "sha256:deep-research",
      baselineHash: "sha256:deep-research",
      updatedAt: T0 - 7 * 86_400_000,
    }),
  ]
}

async function seedStudio(definitions: TemplateDefinitionEnvelope[]): Promise<void> {
  await seedDb(async () => {})
  // The scope control needs a workspace to confine to. The project store is
  // hydrated by an initializer the Storybook shell does not mount, so point it
  // at the workspace `seedDb` just established.
  resetStore(useProjectStore)
  seedStore(useProjectStore, { activeProjectId: await resolveScopeProjectId() })
  templateCatalog.replaceSource(STORY_SOURCE, definitions)
}

const meta = {
  title: "Templates/TemplateStudio",
  component: TemplateStudio,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TemplateStudio>

export default meta
type Story = StoryObj<typeof meta>

/** A mixed library: a draft, two releases of one squad, a built-in, a marketplace row, a deprecated mode. */
export const Library: Story = {
  beforeEach: async () => {
    await seedStudio(makeStudioCatalog())
  },
}

/** Deep link to one release: the inspector shows payload, inputs, scope and lifecycle actions. */
export const SelectedRelease: Story = {
  parameters: {
    nextjs: { appDirectory: true, navigation: { query: { definition: "team.parallel-review" } } },
  },
  beforeEach: async () => {
    await seedStudio(makeStudioCatalog())
  },
}

/** A user draft selected: the editor hand-off and delete are available. */
export const SelectedDraft: Story = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { query: { definition: "user.skill.release-notes", tab: "drafts" } },
    },
  },
  beforeEach: async () => {
    await seedStudio(makeStudioCatalog())
  },
}

/** Nothing in the catalog at all. */
export const Empty: Story = {
  beforeEach: async () => {
    await seedStudio([])
  },
}
