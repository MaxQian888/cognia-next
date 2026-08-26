import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  clearCollabPlans,
  getCollabPlan,
  listCollabPlans,
  replaceCollabPlans,
} from "./collab-plan-mirror"
import type { CollabPlanMirrorRow } from "./collab-plan-mirror-types"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().collabPlans.clear()
})
afterAll(dbFixture.dispose)

function row(overrides: Partial<CollabPlanMirrorRow> = {}): CollabPlanMirrorRow {
  return {
    id: "plan_1",
    orgId: "org_acme",
    workspaceId: "proj-1",
    title: "Migrate the store",
    status: "executing",
    totalSteps: 3,
    completedSteps: 1,
    createdBy: { kind: "human", id: "usr_aaaaaaaaaaaaaaaaaaaaaaaa" },
    createdAt: 1,
    updatedAt: 2,
    fetchedAt: 3,
    ...overrides,
  }
}

describe("collab plan mirror", () => {
  it("lists newest activity first, within one workspace", async () => {
    await replaceCollabPlans("org_acme", [
      row({ id: "plan_old", updatedAt: 10 }),
      row({ id: "plan_new", updatedAt: 20 }),
      row({ id: "plan_elsewhere", workspaceId: "proj-2", updatedAt: 30 }),
    ])

    expect((await listCollabPlans()).map((plan) => plan.id)).toEqual([
      "plan_elsewhere",
      "plan_new",
      "plan_old",
    ])
    expect(
      (await listCollabPlans({ orgId: "org_acme", workspaceId: "proj-1" })).map((plan) => plan.id)
    ).toEqual(["plan_new", "plan_old"])
  })

  it("replaces one org's rows without touching another's", async () => {
    // A client can belong to two orgs; one pull must not blank the other.
    await replaceCollabPlans("org_acme", [row({ id: "plan_a" })])
    await replaceCollabPlans("org_other", [row({ id: "plan_b", orgId: "org_other" })])

    await replaceCollabPlans("org_acme", [row({ id: "plan_c" })])

    const ids = (await listCollabPlans()).map((plan) => plan.id).sort()
    expect(ids).toEqual(["plan_b", "plan_c"])
    // `plan_a` is gone: the server's answer IS the set, and a plan it stopped
    // listing is one this person can no longer see.
    expect(await getCollabPlan("plan_a")).toBeUndefined()
  })

  it("narrows a workspace listing to the org that was asked about", async () => {
    // Two orgs can name the same local workspace id — `projectId` is not
    // globally unique, only unique on one machine.
    await replaceCollabPlans("org_acme", [row({ id: "plan_a" })])
    await replaceCollabPlans("org_other", [row({ id: "plan_b", orgId: "org_other" })])

    const rows = await listCollabPlans({ orgId: "org_acme", workspaceId: "proj-1" })
    expect(rows.map((plan) => plan.id)).toEqual(["plan_a"])
  })

  it("clears everything", async () => {
    await replaceCollabPlans("org_acme", [row()])
    await clearCollabPlans()
    expect(await listCollabPlans()).toEqual([])
  })
})
