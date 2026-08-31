import { PermissionGuard } from "@/lib/plugin/security/permission-guard"
import {
  __resetQuickActionsForTesting,
  getQuickAction,
  registerQuickAction,
} from "@/lib/plugin/registries/quick-action-registry"
import { __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"
import { SelectionQuickActionError, executePluginSelectionQuickAction } from "./plugin-actions"

const candidate = {
  id: "candidate-1",
  text: "selected text",
  sourceApp: "TextEdit",
  sourceTitle: "Draft",
  sourceUrl: "https://example.com/docs",
  origin: "accessibility" as const,
  capturedAt: 1,
  truncated: false,
  editable: true,
  replaceCapability: "paste" as const,
}

afterEach(() => {
  __resetQuickActionsForTesting()
  __resetCommandRegistryForTesting()
})

function registeredGuard(permissions: Array<"selection:read"> = []): PermissionGuard {
  const guard = new PermissionGuard({ confirmDangerousByDefault: true })
  guard.registerPlugin("plug-a", permissions)
  return guard
}

it("executes an eligible metadata action without exposing selected text", async () => {
  const run = jest.fn(async (invocation) => {
    expect(invocation.selection.text).toBeUndefined()
    return { kind: "status" as const, message: invocation.selection.sourceApp }
  })
  registerQuickAction("plug-a", {
    id: "inspect",
    title: "Inspect",
    run,
    surfaces: ["selection"],
    selection: { input: "metadata", output: "status", origins: ["accessibility"] },
  })

  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:inspect")!, candidate, {
      types: ["term"],
    })
  ).resolves.toEqual({ kind: "status", message: "TextEdit" })
})

it("requires consent before exposing selection text", async () => {
  const run = jest.fn(async () => ({ kind: "text" as const, text: "summary" }))
  registerQuickAction("plug-a", {
    id: "summarize",
    title: "Summarize",
    run,
    surfaces: ["selection"],
    selection: { input: "text", output: "preview" },
  })
  const broker = { request: jest.fn(async () => true) }

  await expect(
    executePluginSelectionQuickAction(
      getQuickAction("plug-a:summarize")!,
      candidate,
      { types: ["term"] },
      { guard: registeredGuard(["selection:read"]), broker }
    )
  ).resolves.toEqual({ kind: "text", text: "summary" })
  expect(broker.request).toHaveBeenCalledWith(
    expect.objectContaining({ pluginId: "plug-a", permission: "selection:read" })
  )
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      surface: "selection",
      selection: expect.objectContaining({ text: "selected text" }),
    })
  )
})

it("fails closed when text consent is denied", async () => {
  const run = jest.fn()
  registerQuickAction("plug-a", {
    id: "summarize",
    title: "Summarize",
    run,
    surfaces: ["selection"],
    selection: { input: "text", output: "preview" },
  })

  await expect(
    executePluginSelectionQuickAction(
      getQuickAction("plug-a:summarize")!,
      candidate,
      { types: ["term"] },
      {
        guard: registeredGuard(["selection:read"]),
        broker: { request: async () => false },
      }
    )
  ).rejects.toMatchObject({ code: "permissionDenied" })
  expect(run).not.toHaveBeenCalled()
})

it("refuses actions whose origin or content-type eligibility does not match", async () => {
  registerQuickAction("plug-a", {
    id: "code",
    title: "Explain code",
    run: async () => ({ kind: "text", text: "result" }),
    surfaces: ["selection"],
    selection: {
      input: "metadata",
      output: "preview",
      origins: ["accessibility"],
      contentTypes: ["code"],
    },
  })

  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:code")!, candidate, {
      types: ["term"],
    })
  ).rejects.toMatchObject({ code: "ineligible" })
})

it("rejects malformed and oversized plugin results at the host boundary", async () => {
  registerQuickAction("plug-a", {
    id: "huge",
    title: "Huge",
    run: async () => ({ kind: "text", text: "x".repeat(20_001) }),
    surfaces: ["selection"],
    selection: { input: "metadata", output: "preview" },
  })

  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:huge")!, candidate, { types: [] })
  ).rejects.toBeInstanceOf(SelectionQuickActionError)
  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:huge")!, candidate, { types: [] })
  ).rejects.toMatchObject({ code: "invalidResult" })
})

it("rejects non-selection entries and over-limit candidates before dispatch", async () => {
  registerQuickAction("plug-a", {
    id: "palette-only",
    title: "Palette",
    run: jest.fn(),
    surfaces: ["palette"],
  })
  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:palette-only")!, candidate, {
      types: [],
    })
  ).rejects.toMatchObject({ code: "notSelectionAction" })

  const run = jest.fn()
  registerQuickAction("plug-a", {
    id: "short",
    title: "Short only",
    run,
    surfaces: ["selection"],
    selection: { input: "metadata", output: "none", maxChars: 3 },
  })
  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:short")!, candidate, { types: [] })
  ).rejects.toMatchObject({ code: "ineligible" })
  expect(run).not.toHaveBeenCalled()
})

it("sanitizes source metadata again and accepts bounded variants", async () => {
  const run = jest.fn(async (invocation) => {
    expect(invocation.selection.sourceUrl).toBe("https://example.com/docs")
    return { kind: "variants" as const, variants: ["One", "Two"] }
  })
  registerQuickAction("plug-a", {
    id: "variants",
    title: "Variants",
    run,
    surfaces: ["selection"],
    selection: { input: "metadata", output: "preview" },
  })
  await expect(
    executePluginSelectionQuickAction(
      getQuickAction("plug-a:variants")!,
      {
        ...candidate,
        sourceUrl: "https://user:secret@example.com/docs?token=secret#private",
      },
      { types: [] }
    )
  ).resolves.toEqual({ kind: "variants", variants: ["One", "Two"] })
})

it("normalizes void/status outputs and rejects output-shape mismatches", async () => {
  registerQuickAction("plug-a", {
    id: "none",
    title: "None",
    run: async () => undefined,
    surfaces: ["selection"],
    selection: { input: "metadata", output: "none" },
  })
  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:none")!, candidate, { types: [] })
  ).resolves.toBeUndefined()

  registerQuickAction("plug-a", {
    id: "status",
    title: "Status",
    run: async () => undefined,
    surfaces: ["selection"],
    selection: { input: "metadata", output: "status" },
  })
  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:status")!, candidate, { types: [] })
  ).resolves.toEqual({ kind: "status" })

  registerQuickAction("plug-a", {
    id: "mismatch",
    title: "Mismatch",
    run: async () => ({ kind: "status", message: "done" }),
    surfaces: ["selection"],
    selection: { input: "metadata", output: "replace" },
  })
  await expect(
    executePluginSelectionQuickAction(getQuickAction("plug-a:mismatch")!, candidate, {
      types: [],
    })
  ).rejects.toMatchObject({ code: "invalidResult" })
})

it.each([
  [{ kind: "variants", variants: [] }, "preview"],
  [{ kind: "variants", variants: ["ok"] }, "copy"],
  [{ kind: "status", message: "x".repeat(1_001) }, "status"],
  [{ kind: "unknown" }, "status"],
  ["plain string", "status"],
] as const)("rejects invalid normalized result %#", async (result, output) => {
  registerQuickAction("plug-a", {
    id: `invalid-${output}-${String(result).length}`,
    title: "Invalid",
    run: async () => result as never,
    surfaces: ["selection"],
    selection: { input: "metadata", output },
  })
  const entry = getQuickAction(`plug-a:invalid-${output}-${String(result).length}`)!
  await expect(
    executePluginSelectionQuickAction(entry, candidate, { types: [] })
  ).rejects.toMatchObject({ code: "invalidResult" })
})

it.each([
  [undefined, "preview"],
  [{ kind: "text", text: "ok" }, "status"],
  [{ kind: "text", text: "" }, "preview"],
  [{ kind: "text", text: 42 }, "preview"],
  [{ kind: "variants", variants: Array.from({ length: 9 }, (_, i) => String(i)) }, "preview"],
  [{ kind: "variants", variants: [""] }, "preview"],
] as const)("rejects additional output-policy edge %#", async (result, output) => {
  const id = `edge-${output}-${String(result).length}`
  registerQuickAction("plug-a", {
    id,
    title: "Edge",
    run: async () => result as never,
    surfaces: ["selection"],
    selection: { input: "metadata", output },
  })
  await expect(
    executePluginSelectionQuickAction(getQuickAction(`plug-a:${id}`)!, candidate, { types: [] })
  ).rejects.toMatchObject({ code: "invalidResult" })
})

it("accepts a bounded status message and drops unusable source URLs", async () => {
  const run = jest.fn(async (invocation) => {
    expect(invocation.selection.sourceUrl).toBeUndefined()
    return { kind: "status" as const, message: "done" }
  })
  registerQuickAction("plug-a", {
    id: "safe-status",
    title: "Safe status",
    run,
    surfaces: ["selection"],
    selection: { input: "metadata", output: "status" },
  })
  await expect(
    executePluginSelectionQuickAction(
      getQuickAction("plug-a:safe-status")!,
      { ...candidate, sourceUrl: "file:///private" },
      { types: [] }
    )
  ).resolves.toEqual({ kind: "status", message: "done" })
})
