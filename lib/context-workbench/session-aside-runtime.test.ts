import type { ChatSession } from "@cognia/agent-config-types"
import {
  resolveSessionAsideRuntime,
  resolveSessionAsideRuntimeWithAgent,
} from "./session-aside-runtime"

const session: ChatSession = { id: "aside", title: "Aside", createdAt: 1, updatedAt: 1 }
const parentRuntimeRef = { kind: "external" as const, agentId: "parent-agent" }
const capable = { protocol: "acp" as const, capabilities: { permissionModes: ["plan" as const] } }

describe("session aside runtime selection", () => {
  it("maps built-in auto to default without dropping the parent's plan ceiling", () => {
    const input = {
      session: { ...session, asideWriteAccess: true, permissionMode: "auto" as const },
      parentRuntimeRef,
    }
    expect(resolveSessionAsideRuntime(input).permissionCeiling.permissionMode).toBe("default")
    expect(
      resolveSessionAsideRuntime({
        ...input,
        parentPermission: { permissionMode: "plan" },
      })
    ).toMatchObject({
      runtimeRef: { kind: "builtin" },
      permissionCeiling: { permissionMode: "plan" },
      readOnly: true,
    })
  })

  it("keeps a plan-capable parent's external lane under a hard plan ceiling", () => {
    expect(
      resolveSessionAsideRuntime({ session, parentRuntimeRef, external: capable })
    ).toMatchObject({
      runtimeRef: parentRuntimeRef,
      readOnly: true,
      usesBuiltinFallback: false,
      permissionCeiling: { permissionMode: "plan" },
    })
  })

  it("uses builtin for unknown or incapable read-only agents and restores external on unlock", () => {
    for (const external of [undefined, { protocol: "http" as const }]) {
      expect(resolveSessionAsideRuntime({ session, parentRuntimeRef, external })).toMatchObject({
        runtimeRef: { kind: "builtin" },
        usesBuiltinFallback: true,
      })
      expect(
        resolveSessionAsideRuntime({
          session: { ...session, asideWriteAccess: true },
          parentRuntimeRef,
          external,
        })
      ).toMatchObject({
        runtimeRef: parentRuntimeRef,
        readOnly: false,
        usesBuiltinFallback: false,
      })
    }
  })

  it("keeps inherited parent or explicit aside plan ceilings after unlock", () => {
    for (const input of [
      {
        session: { ...session, asideWriteAccess: true },
        parentPermission: { permissionMode: "plan" as const },
      },
      { session: { ...session, asideWriteAccess: true, permissionMode: "plan" as const } },
    ]) {
      expect(resolveSessionAsideRuntime({ ...input, parentRuntimeRef })).toMatchObject({
        runtimeRef: { kind: "builtin" },
        readOnly: true,
        usesBuiltinFallback: true,
      })
    }
  })

  it("preserves stronger parent tool restrictions by selecting builtin even for capable external", () => {
    expect(
      resolveSessionAsideRuntime({
        session,
        parentRuntimeRef,
        external: capable,
        parentPermission: { allowedTools: ["Read"] },
      })
    ).toMatchObject({ runtimeRef: { kind: "builtin" }, fallbackReason: "permission-unattested" })
  })

  it("forces non-direct compositions builtin and keeps host execution opt-in", () => {
    expect(
      resolveSessionAsideRuntime({
        session,
        parentRuntimeRef,
        external: capable,
        forceBuiltin: true,
      })
    ).toMatchObject({
      runtimeRef: { kind: "builtin" },
      fallbackReason: "non-direct",
    })
    const host = {
      kind: "host" as const,
      configId: "host-agent",
      revision: "rev",
      lifecycleGeneration: 1,
    }
    expect(resolveSessionAsideRuntime({ session, parentRuntimeRef: host }).runtimeRef.kind).toBe(
      "builtin"
    )
    expect(
      resolveSessionAsideRuntime({
        session: { ...session, asideWriteAccess: true },
        parentRuntimeRef: host,
      }).runtimeRef
    ).toBe(host)
  })

  it("uses one lazy capability loader for send and display decisions", async () => {
    const loader = jest.fn(async () => capable)
    const input = { session, parentRuntimeRef }
    expect(await resolveSessionAsideRuntimeWithAgent(input, loader)).toEqual(
      resolveSessionAsideRuntime({ ...input, external: capable })
    )
    expect(loader).toHaveBeenCalledWith("parent-agent")
    await resolveSessionAsideRuntimeWithAgent(
      { session, parentRuntimeRef: { kind: "builtin" } },
      loader
    )
    expect(loader).toHaveBeenCalledTimes(1)
  })
})
