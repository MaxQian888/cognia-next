import type { Meta, StoryObj } from "@storybook/nextjs"

import { TemplatesMobileBody } from "./templates-mobile-body"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { templateCatalog } from "@/lib/templates/catalog"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import { useProjectStore } from "@/stores/project/project-store"

// The phone-shaped catalog: search, filter sheet, a card list, and a detail
// sheet that offers instantiate and fork. Selection and filters are URL state
// shared with the Studio, and Storybook's router mock does not round-trip
// `router.replace`, so the open-sheet story preselects through the navigation
// parameters.

const STORY_SOURCE = "storybook"
const T0 = Date.UTC(2026, 7, 20, 9, 0, 0)

function envelope(over: Partial<TemplateDefinitionEnvelope>): TemplateDefinitionEnvelope {
  return {
    apiVersion: "cognia.dev/templates/v1",
    id: "user.skill.notes",
    domain: "skill",
    version: "1.0.0",
    status: "published",
    revision: 1,
    metadata: { name: "Notes", description: "Take notes" },
    payload: { name: "Notes", content: "" },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
    contentHash: "sha256:notes",
    baselineHash: "sha256:notes",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

function makeMobileCatalog(): TemplateDefinitionEnvelope[] {
  return [
    envelope({
      id: "team.parallel-review",
      domain: "agentTeam",
      version: "1.2.0",
      revision: 3,
      metadata: {
        name: "Parallel review",
        description: "A lead plus three reviewers who each take one slice of a pull request.",
        tags: ["review", "squad"],
      },
      payload: { team: { name: "Parallel review" } },
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
      contentHash: "sha256:parallel-review",
      baselineHash: "sha256:parallel-review",
    }),
    envelope({
      id: "user.skill.release-notes",
      domain: "skill",
      revision: 4,
      metadata: {
        name: "Release notes writer",
        description: "Turns a merged changelog into release notes with a friendly tone.",
      },
      payload: { name: "Release notes writer", content: "Summarise {{changelog}}." },
      inputs: [{ id: "changelog", label: "Changelog", kind: "string", required: true }],
      contentHash: "sha256:release-notes",
      baselineHash: "sha256:release-notes",
    }),
    envelope({
      id: "builtin.workflow.daily-digest",
      domain: "workflow",
      version: "2.0.0",
      metadata: {
        name: "Daily digest",
        description: "Collects inbox activity every morning and posts one summary.",
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
      metadata: {
        name: "Support agent",
        description: "A patient first-line support persona with escalation rules.",
        author: "Acme Publishing",
      },
      payload: { name: "Support agent" },
      provenance: { source: "marketplace", trust: "verified-publisher", publisher: "acme" },
      contentHash: "sha256:support-agent",
      baselineHash: "sha256:support-agent",
    }),
  ]
}

async function seedMobile(definitions: TemplateDefinitionEnvelope[]): Promise<void> {
  await seedDb(async () => {})
  resetStore(useProjectStore)
  seedStore(useProjectStore, { activeProjectId: await resolveScopeProjectId() })
  templateCatalog.replaceSource(STORY_SOURCE, definitions)
}

const meta = {
  title: "Mobile/Templates/TemplatesMobileBody",
  component: TemplatesMobileBody,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[720px] w-full max-w-[420px] overflow-y-auto border-x bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TemplatesMobileBody>

export default meta
type Story = StoryObj<typeof meta>

/** Four templates across four domains and three trust tiers. */
export const Catalog: Story = {
  beforeEach: async () => {
    await seedMobile(makeMobileCatalog())
  },
}

/** Deep link: the detail sheet opens on a squad template with two inputs. */
export const DetailSheetOpen: Story = {
  parameters: {
    nextjs: { appDirectory: true, navigation: { query: { definition: "team.parallel-review" } } },
  },
  beforeEach: async () => {
    await seedMobile(makeMobileCatalog())
  },
}

/** Nothing in the catalog. */
export const Empty: Story = {
  beforeEach: async () => {
    await seedMobile([])
  },
}
