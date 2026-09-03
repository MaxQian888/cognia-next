import type { Meta, StoryObj } from "@storybook/nextjs"

import { SquadTemplateProvenance } from "./squad-template-provenance"
import { seedDb } from "@/lib/storybook/seed-db"
import { templateCatalog } from "@/lib/templates/catalog"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"
import { getTemplateRuntime } from "@/lib/templates/runtime"

// What a Squad was made from. The only link is the `TemplateInstanceRecord`
// whose resources name the team, so the lineage story writes one into Dexie
// through the production repository and registers two releases of the source
// definition in the catalog so the version picker has somewhere to go.

const SQUAD_ID = "squad-story"
const DEFINITION_ID = "team.parallel-review"
const STORY_SOURCE = "storybook"
const T0 = Date.UTC(2026, 7, 20, 9, 0, 0)

function release(version: string, revision: number): TemplateDefinitionEnvelope {
  return {
    apiVersion: "cognia.dev/templates/v1",
    id: DEFINITION_ID,
    domain: "agentTeam",
    version,
    status: "published",
    revision,
    metadata: {
      name: "Parallel review",
      description: "A lead plus three reviewers who each take one slice of a pull request.",
    },
    payload: { team: { name: "Parallel review" } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
    contentHash: `sha256:parallel-review-${version}`,
    baselineHash: `sha256:parallel-review-${version}`,
    createdAt: T0,
    updatedAt: T0,
  }
}

function instanceOf(snapshot: TemplateDefinitionEnvelope): TemplateInstanceRecord {
  return {
    id: "inst-parallel-review",
    idempotencyKey: "story:parallel-review",
    source: {
      definitionId: snapshot.id,
      version: snapshot.version,
      revision: snapshot.revision,
      status: snapshot.status,
      contentHash: snapshot.contentHash,
      snapshot,
    },
    bindingFingerprint: "sha256:bindings",
    bindings: { repository: "cognia/cognia-next" },
    resources: [{ domain: "agentTeam", id: SQUAD_ID }],
    baseline: snapshot.payload,
    createdAt: T0,
    updatedAt: T0,
  }
}

const meta = {
  title: "Settings/Squads/SquadTemplateProvenance",
  component: SquadTemplateProvenance,
  parameters: { layout: "padded" },
  args: { squadId: SQUAD_ID, className: "rounded-md border p-3" },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SquadTemplateProvenance>

export default meta
type Story = StoryObj<typeof meta>

/** Created from v1.1.0 while v1.2.0 is available: the instance card offers the update. */
export const WithLineage: Story = {
  beforeEach: async () => {
    await seedDb(async () => {
      await getTemplateRuntime().repository.putInstance(instanceOf(release("1.1.0", 2)))
    })
    templateCatalog.replaceSource(STORY_SOURCE, [release("1.1.0", 2), release("1.2.0", 3)])
  },
}

/** A Squad made with New Squad, or before lineage existed: one sentence. */
export const NoLineage: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
    templateCatalog.replaceSource(STORY_SOURCE, [])
  },
}
