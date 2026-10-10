/**
 * @jest-environment jsdom
 */

/**
 * Deliberately-inert corners of the template platform.
 *
 * Working Rule 7: intentional dormancy has to be documented at the type, shown
 * as inert in the UI, and pinned by a test. Any two of the three is a latent
 * bug, because the next reader cannot tell "not built yet" from "built and
 * broken". These are the third leg.
 */

import { readFile } from "node:fs/promises"

import { createFullDomainAdapters } from "./adapters"
import type { TemplateOperation } from "./service"

describe("TemplateOperation kinds", () => {
  /**
   * Only `create` is emitted. If an adapter starts producing another kind, this
   * fails and the surfaces that render an operation list have to be checked,
   * which is the point.
   */
  it("is only ever produced as `create` today", async () => {
    const noop = new Proxy({} as never, { get: () => async () => undefined })
    const adapters = createFullDomainAdapters(noop)
    const kinds = new Set<TemplateOperation["kind"]>()
    for (const adapter of adapters) {
      const plan = await adapter.preflight({
        definition: {
          id: "x",
          domain: adapter.domain,
          metadata: { name: "x" },
          payload: {},
          inputs: [],
          version: null,
          revision: 1,
          status: "draft",
          dependencies: [],
          capabilities: [],
          compatibility: { platforms: ["desktop"] },
          provenance: { source: "user" },
          contentHash: "h",
          createdAt: 0,
          updatedAt: 0,
          apiVersion: "cognia.ai/templates/v1",
        } as never,
        platform: "desktop",
        bindings: {},
      })
      for (const operation of plan.operations) kinds.add(operation.kind)
    }
    expect([...kinds]).toEqual(["create"])
  })
})

describe("the templateDeviceBindings table", () => {
  /**
   * Bindings are persisted inline on `TemplateInstanceRecord`, and every read
   * and write goes through those, so this table has never held a row. It stays
   * declared for the case the inline copy cannot serve, a binding that is per
   * DEVICE rather than per instance, which is also why it is local-only and
   * absent from `lib/sync`.
   */
  it("has no writer in the instantiation path", async () => {
    const source = await readFile(new URL("./service.ts", import.meta.url).pathname, "utf8")
    expect(source).not.toContain("templateDeviceBindings")
    expect(source).not.toContain("putTemplateDeviceBinding")
  })

  it("is not one of the tables that sync", async () => {
    const { COMPANION_SYNC_TABLES } = await import("@/lib/data-governance/table-catalog")
    expect([...COMPANION_SYNC_TABLES]).not.toContain("templateDeviceBindings")
  })
})
