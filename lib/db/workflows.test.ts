// CRUD coverage for the workflows table — list/get/create/update/replace/
// delete plus duplicate, seed, and the regenerateNodeIds helper.

import "fake-indexeddb/auto"
import {
  __resetRunCountCacheForTesting,
  addTagToWorkflows,
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  getRecentlyFailedWorkflowIds,
  getRunCounts,
  getWorkflow,
  listTemplateWorkflows,
  listUserWorkflows,
  listWorkflows,
  listWorkflowsByUpdated,
  listWorkflowsInFolder,
  moveWorkflowsToFolder,
  moveWorkflowToFolder,
  regenerateNodeIds,
  replaceWorkflow,
  seedBuiltInWorkflows,
  updateWorkflow,
} from "./workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import type { VisualWorkflow } from "@/types/workflow/visual"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  await getDb().workflowFolders.clear()
  await getDb().workflowRuns.clear()
  __resetRunCountCacheForTesting()
})

function manualNode(id: string, x = 0): VisualWorkflow["nodes"][number] {
  return {
    id,
    type: "trigger.manual",
    typeVersion: 1,
    position: { x, y: 0 },
    data: { label: "Run", params: {} },
  }
}

describe("createWorkflow", () => {
  it("inserts a row with sensible defaults and returns the new shape", async () => {
    const wf = await createWorkflow({ name: "  Daily digest  " })
    expect(wf.id).toMatch(/^wf_/)
    expect(wf.name).toBe("Daily digest")
    expect(wf.schemaVersion).toBe(1)
    expect(wf.isBuiltIn).toBe(false)
    expect(wf.isTemplate).toBe(false)
    expect(wf.tags).toEqual([])
    expect(wf.nodes).toEqual([])
    expect(wf.edges).toEqual([])
    expect(wf.settings.errorPolicy).toBe("stop")
    expect(wf.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(wf.createdAt).toBe(wf.updatedAt)
  })

  it("falls back to 'Untitled workflow' on empty name", async () => {
    const wf = await createWorkflow({ name: "   " })
    expect(wf.name).toBe("Untitled workflow")
  })

  it("preserves caller-supplied nodes/edges/settings/viewport", async () => {
    const wf = await createWorkflow({
      name: "X",
      nodes: [manualNode("n1")],
      edges: [],
      tags: ["seed"],
      settings: {
        errorPolicy: "continue",
        timeoutMs: 1000,
        concurrency: 5,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 500 },
      },
      viewport: { x: 100, y: 200, zoom: 1.5 },
    })
    expect(wf.nodes).toHaveLength(1)
    expect(wf.tags).toEqual(["seed"])
    expect(wf.settings.errorPolicy).toBe("continue")
    expect(wf.settings.concurrency).toBe(5)
    expect(wf.viewport?.zoom).toBe(1.5)
  })
})

describe("listWorkflows / listWorkflowsByUpdated", () => {
  it("returns rows ordered by name ascending", async () => {
    await createWorkflow({ name: "Charlie" })
    await createWorkflow({ name: "Alpha" })
    await createWorkflow({ name: "Bravo" })
    const rows = await listWorkflows()
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("orders by updatedAt newest-first when requested", async () => {
    const a = await createWorkflow({ name: "A" })
    await new Promise((r) => setTimeout(r, 5))
    const b = await createWorkflow({ name: "B" })
    await new Promise((r) => setTimeout(r, 5))
    await updateWorkflow(a.id, { description: "touch" })
    const rows = await listWorkflowsByUpdated()
    expect(rows[0].id).toBe(a.id)
    expect(rows[1].id).toBe(b.id)
  })
})

describe("listTemplateWorkflows / listUserWorkflows", () => {
  it("filters templates and built-ins out of the user list", async () => {
    const userOne = await createWorkflow({ name: "User one" })
    await createWorkflow({ name: "Template one", isTemplate: true })
    await seedBuiltInWorkflows([
      {
        ...userOne,
        id: "wf_builtin_seed",
        name: "Seed built-in",
        isBuiltIn: true,
        isTemplate: false,
      },
    ])
    const templates = await listTemplateWorkflows()
    const userOnes = await listUserWorkflows()
    expect(templates.map((w) => w.name)).toEqual(["Template one"])
    expect(userOnes.map((w) => w.name)).toEqual(["User one"])
  })
})

describe("updateWorkflow / replaceWorkflow", () => {
  it("merges patch and bumps updatedAt", async () => {
    const wf = await createWorkflow({ name: "A" })
    const before = wf.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await updateWorkflow(wf.id, { description: "patched" })
    const fresh = await getWorkflow(wf.id)
    expect(fresh?.description).toBe("patched")
    expect(fresh?.updatedAt).toBeGreaterThan(before)
  })

  it("replaces the full row but refuses missing ids", async () => {
    const wf = await createWorkflow({ name: "A" })
    const replacement = { ...wf, name: "Renamed", nodes: [manualNode("n_new")] }
    await replaceWorkflow(replacement)
    const fresh = await getWorkflow(wf.id)
    expect(fresh?.name).toBe("Renamed")
    expect(fresh?.nodes).toHaveLength(1)
    await expect(replaceWorkflow({ ...wf, id: "wf_missing" })).rejects.toThrow(/not found/)
  })
})

describe("deleteWorkflow", () => {
  it("removes a user-created row", async () => {
    const wf = await createWorkflow({ name: "A" })
    await deleteWorkflow(wf.id)
    expect(await getWorkflow(wf.id)).toBeUndefined()
  })

  it("rejects deletion of built-ins", async () => {
    const wf = await createWorkflow({ name: "Built-in source" })
    await seedBuiltInWorkflows([{ ...wf, id: "wf_builtin_x" }])
    await expect(deleteWorkflow("wf_builtin_x")).rejects.toThrow(/Built-in/)
  })

  it("is a no-op on missing ids", async () => {
    await expect(deleteWorkflow("wf_missing")).resolves.toBeUndefined()
  })

  it("cascades to drop orphan fan-out subscriptions", async () => {
    const { createFanoutSubscription, listForWorkflow } =
      await import("@/lib/db/workflow-fanout-subscriptions")
    const wf = await createWorkflow({ name: "ToDelete" })
    await createFanoutSubscription({
      workflowId: wf.id,
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    expect(await listForWorkflow(wf.id, { includeDisabled: true })).toHaveLength(1)
    await deleteWorkflow(wf.id)
    expect(await listForWorkflow(wf.id, { includeDisabled: true })).toHaveLength(0)
  })
})

describe("duplicateWorkflow", () => {
  it("clones the row but resets isBuiltIn / isTemplate and renames", async () => {
    const wf = await createWorkflow({ name: "Original" })
    await seedBuiltInWorkflows([{ ...wf, id: "wf_builtin_z", isTemplate: true }])
    const copy = await duplicateWorkflow("wf_builtin_z")
    expect(copy.id).not.toBe("wf_builtin_z")
    expect(copy.name).toBe("Original (copy)")
    expect(copy.isBuiltIn).toBe(false)
    expect(copy.isTemplate).toBe(false)
  })

  it("throws when the source is missing", async () => {
    await expect(duplicateWorkflow("wf_missing")).rejects.toThrow(/not found/)
  })
})

describe("seedBuiltInWorkflows", () => {
  it("is idempotent — repeat calls don't duplicate rows", async () => {
    const sample = await createWorkflow({ name: "Source" })
    await getDb().workflows.clear()
    const builtIn: VisualWorkflow = {
      ...sample,
      id: "wf_builtin_seed_a",
      name: "Seed A",
      isBuiltIn: true,
    }
    await seedBuiltInWorkflows([builtIn])
    await seedBuiltInWorkflows([builtIn])
    const all = await listWorkflows()
    expect(all.filter((w) => w.isBuiltIn).length).toBe(1)
  })

  it("ignores empty input", async () => {
    await seedBuiltInWorkflows([])
    expect(await listWorkflows()).toEqual([])
  })
})

describe("regenerateNodeIds", () => {
  it("rewrites node ids and patches edge endpoints", () => {
    const wf: VisualWorkflow = {
      id: "wf_x",
      schemaVersion: 1,
      name: "x",
      createdAt: 0,
      updatedAt: 0,
      nodes: [manualNode("n_a"), manualNode("n_b", 200)],
      edges: [{ id: "e1", source: "n_a", target: "n_b" }],
      settings: {
        errorPolicy: "stop",
        timeoutMs: 60_000,
        concurrency: 1,
        retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
      },
    }
    const fresh = regenerateNodeIds(wf)
    expect(fresh.nodes[0].id).not.toBe("n_a")
    expect(fresh.nodes[1].id).not.toBe("n_b")
    // Edge endpoints follow the rename map.
    expect(fresh.edges[0].source).toBe(fresh.nodes[0].id)
    expect(fresh.edges[0].target).toBe(fresh.nodes[1].id)
  })
})

describe("folder organization", () => {
  it("createWorkflow defaults folderId to the root sentinel", async () => {
    const wf = await createWorkflow({ name: "A" })
    expect(wf.folderId).toBe(ROOT_FOLDER_ID)
  })

  it("createWorkflow honors a caller-supplied folderId", async () => {
    const wf = await createWorkflow({ name: "A", folderId: "wff_x" })
    expect(wf.folderId).toBe("wff_x")
  })

  it("moveWorkflowToFolder updates folderId and listWorkflowsInFolder finds it", async () => {
    const wf = await createWorkflow({ name: "A" })
    await moveWorkflowToFolder(wf.id, "wff_target")
    expect((await getWorkflow(wf.id))?.folderId).toBe("wff_target")
    const inFolder = await listWorkflowsInFolder("wff_target")
    expect(inFolder.map((w) => w.id)).toEqual([wf.id])
  })

  it("moveWorkflowToFolder coerces a falsy folder to root", async () => {
    const wf = await createWorkflow({ name: "A", folderId: "wff_x" })
    await moveWorkflowToFolder(wf.id, "")
    expect((await getWorkflow(wf.id))?.folderId).toBe(ROOT_FOLDER_ID)
  })

  it("moveWorkflowsToFolder batch-moves and is a no-op on empty input", async () => {
    const a = await createWorkflow({ name: "A" })
    const b = await createWorkflow({ name: "B" })
    await moveWorkflowsToFolder([a.id, b.id], "wff_bulk")
    expect((await listWorkflowsInFolder("wff_bulk")).map((w) => w.id).sort()).toEqual(
      [a.id, b.id].sort()
    )
    await expect(moveWorkflowsToFolder([], "wff_bulk")).resolves.toBeUndefined()
  })
})

describe("addTagToWorkflows", () => {
  it("adds a tag to each row without duplicating", async () => {
    const a = await createWorkflow({ name: "A", tags: ["x"] })
    const b = await createWorkflow({ name: "B" })
    await addTagToWorkflows([a.id, b.id], "shared")
    await addTagToWorkflows([a.id], "shared") // idempotent
    expect((await getWorkflow(a.id))?.tags).toEqual(["x", "shared"])
    expect((await getWorkflow(b.id))?.tags).toEqual(["shared"])
  })

  it("ignores empty ids or blank tag", async () => {
    const a = await createWorkflow({ name: "A" })
    await addTagToWorkflows([], "t")
    await addTagToWorkflows([a.id], "   ")
    expect((await getWorkflow(a.id))?.tags).toEqual([])
  })
})

describe("getRunCounts", () => {
  it("counts runs per workflow via the workflowId index", async () => {
    const a = await createWorkflow({ name: "A" })
    const b = await createWorkflow({ name: "B" })
    await getDb().workflowRuns.bulkPut([
      { id: "r1", workflowId: a.id, status: "success", startedAt: 1 },
      { id: "r2", workflowId: a.id, status: "error", startedAt: 2 },
      { id: "r3", workflowId: b.id, status: "success", startedAt: 3 },
    ] as never)
    const counts = await getRunCounts([a.id, b.id])
    expect(counts.get(a.id)).toBe(2)
    expect(counts.get(b.id)).toBe(1)
  })

  it("returns an empty map for empty input", async () => {
    expect((await getRunCounts([])).size).toBe(0)
  })
})

describe("getRecentlyFailedWorkflowIds", () => {
  it("collects workflow ids with a failed run at or after the cutoff", async () => {
    const a = await createWorkflow({ name: "A" })
    const b = await createWorkflow({ name: "B" })
    await getDb().workflowRuns.bulkPut([
      { id: "r1", workflowId: a.id, status: "failed", startedAt: 1000 },
      { id: "r2", workflowId: a.id, status: "succeeded", startedAt: 2000 },
      { id: "r3", workflowId: b.id, status: "failed", startedAt: 100 },
    ] as never)
    const ids = await getRecentlyFailedWorkflowIds(500)
    expect(ids.has(a.id)).toBe(true) // failed at 1000 ≥ 500
    expect(ids.has(b.id)).toBe(false) // failed at 100 < 500
  })
})
