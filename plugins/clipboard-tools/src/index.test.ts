/**
 * @jest-environment jsdom
 */

import type { PluginContext, PluginNodeDef, PluginToolRegistration } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import definition, {
  bytesToBase64,
  clearClipboard,
  createClipboardTools,
  createClipboardWorkflowNodes,
  imageToolResult,
  readClipboardImage,
  readClipboardStatus,
  sniffImageMime,
  writeClipboardText,
} from "./index"

type Clipboard = PluginContext["clipboard"]

function makeClipboard(overrides: Partial<Clipboard> = {}): jest.Mocked<Clipboard> {
  return {
    readText: jest.fn(async () => ""),
    writeText: jest.fn(async () => undefined),
    readImage: jest.fn(async () => null),
    writeImage: jest.fn(async () => undefined),
    hasText: jest.fn(async () => false),
    hasImage: jest.fn(async () => false),
    clear: jest.fn(async () => undefined),
    ...overrides,
  } as jest.Mocked<Clipboard>
}

function makeCtx(clipboard: Clipboard) {
  const tools: Record<string, PluginToolRegistration> = {}
  const nodes: Record<string, PluginNodeDef> = {}
  const disposeNode = jest.fn()
  const ctx = {
    pluginId: "cognia-clipboard-tools",
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    clipboard,
    agent: {
      registerTool: (tool: PluginToolRegistration) => {
        tools[tool.name] = tool
        return () => {
          delete tools[tool.name]
        }
      },
    },
    workflow: {
      registerNode: (node: PluginNodeDef) => {
        nodes[node.kind] = node
        return disposeNode
      },
    },
  } as unknown as PluginContext
  return { ctx, tools, nodes, disposeNode }
}

const run = (tool: PluginToolRegistration, args: Record<string, unknown> = {}) =>
  tool.execute(args, { config: {} })

describe("clipboard-tools (built-in)", () => {
  it("spreads plugin.json as its manifest so declared tools survive the builtin overlay", () => {
    expect(definition.manifest).toBe(manifestJson)
    expect(definition.manifest.capabilities).toEqual(["tools", "workflow"])
    expect(definition.manifest.permissions).toEqual(["clipboard:read", "clipboard:write"])
  })

  it("registers exactly the tools plugin.json declares, with matching approval gates", async () => {
    const { ctx, tools } = makeCtx(makeClipboard())
    await definition.activate?.(ctx)
    const declared = (manifestJson.tools ?? []).map((t) => t.name).sort()
    expect(Object.keys(tools).sort()).toEqual(declared)
    for (const declaredTool of manifestJson.tools ?? []) {
      const registered = tools[declaredTool.name].definition
      expect(registered.requiresApproval).toBe(
        (declaredTool as { requiresApproval?: boolean }).requiresApproval
      )
      expect(registered.parametersSchema).toEqual(declaredTool.parametersSchema)
      // No clipboard tool takes a filesystem path, so none declares an access class.
      expect(registered.access).toBeUndefined()
      expect(declaredTool).not.toHaveProperty("access")
    }
    // Overwriting / emptying the user's clipboard needs approval; reads do not.
    expect(tools.clipboard_write_text.definition.requiresApproval).toBe(true)
    expect(tools.clipboard_clear.definition.requiresApproval).toBe(true)
    expect(tools.clipboard_status.definition.requiresApproval).toBeUndefined()
  })

  it("localizes every workflow node's label and description in both locales", () => {
    const nodes = createClipboardWorkflowNodes(makeClipboard())
    const locales = manifestJson.i18n.locales as Record<string, Record<string, string>>
    for (const node of nodes) {
      for (const field of ["label", "description"] as const) {
        const key = `workflow.nodes.${node.kind}.${field}`
        // English bundle matches the author fallback; zh-CN is a real translation.
        expect(locales.en[key]).toBe(node[field])
        expect(locales["zh-CN"][key]).toEqual(expect.any(String))
        expect(locales["zh-CN"][key]).not.toBe(node[field])
      }
    }
  })

  it("registers read, write and clear workflow nodes with the fields the editor reads", async () => {
    const { ctx, nodes } = makeCtx(makeClipboard())
    await definition.activate?.(ctx)
    expect(Object.keys(nodes).sort()).toEqual([
      "action.clear",
      "action.readText",
      "action.writeText",
    ])
    for (const node of Object.values(nodes)) {
      expect(node).toMatchObject({
        category: "plugin",
        typeVersion: 1,
        retryable: false,
      })
      expect(typeof node.label).toBe("string")
      expect(typeof node.description).toBe("string")
      expect(typeof node.iconName).toBe("string")
      expect(node.paramsSchema).toMatchObject({ type: "object" })
    }
    expect(nodes["action.writeText"].paramsSchema).toMatchObject({ required: ["text"] })
  })

  it("deactivate disposes every workflow node and re-activation does not double-register", async () => {
    const { ctx, disposeNode } = makeCtx(makeClipboard())
    await definition.activate?.(ctx)
    await definition.deactivate?.(ctx)
    expect(disposeNode).toHaveBeenCalledTimes(3)
    await definition.activate?.(ctx)
    await definition.activate?.(ctx)
    // Second activate disposes the first activation's three nodes before re-registering.
    expect(disposeNode).toHaveBeenCalledTimes(6)
    await definition.deactivate?.(ctx)
  })

  describe("clipboard_status", () => {
    it("reads text only when the clipboard reports text", async () => {
      const clipboard = makeClipboard({
        hasText: jest.fn(async () => true),
        hasImage: jest.fn(async () => true),
        readText: jest.fn(async () => "hello"),
      })
      const status = await readClipboardStatus(clipboard)
      expect(status).toEqual({ ok: true, hasText: true, hasImage: true, content: "hello" })
    })

    it("returns an empty content without reading when the clipboard holds no text", async () => {
      const clipboard = makeClipboard()
      const status = await readClipboardStatus(clipboard)
      expect(status).toEqual({ ok: true, hasText: false, hasImage: false, content: "" })
      expect(clipboard.readText).not.toHaveBeenCalled()
    })

    it("surfaces the host's permission / availability error as ok:false", async () => {
      const clipboard = makeClipboard({
        hasText: jest.fn(async () => {
          throw new Error("Browser clipboard text read is unavailable in this environment.")
        }),
      })
      const status = await readClipboardStatus(clipboard)
      expect(status).toEqual({ ok: false, error: expect.stringMatching(/unavailable/) })
    })

    it("is wired to ctx.clipboard through the registered tool", async () => {
      const clipboard = makeClipboard({
        hasText: jest.fn(async () => true),
        readText: jest.fn(async () => "via tool"),
      })
      const { ctx, tools } = makeCtx(clipboard)
      await definition.activate?.(ctx)
      await expect(run(tools.clipboard_status)).resolves.toMatchObject({ content: "via tool" })
    })
  })

  describe("clipboard_read_image", () => {
    it("the tool returns an MCP image block the model can see", async () => {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
      const [, imageTool] = createClipboardTools(
        makeClipboard({ readImage: jest.fn(async () => bytes) })
      )
      await expect(run(imageTool)).resolves.toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, mimeType: "image/png", byteLength: 4 }),
          },
          { type: "image", data: bytesToBase64(bytes), mimeType: "image/png" },
        ],
      })
    })

    it("the tool keeps a failure as a plain ok:false envelope", async () => {
      const [, imageTool] = createClipboardTools(makeClipboard())
      await expect(run(imageTool)).resolves.toMatchObject({ ok: false })
      expect(imageToolResult({ ok: false, error: "x" })).toEqual({ ok: false, error: "x" })
    })

    it("sniffs the real image encoding from its magic bytes", () => {
      expect(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
      expect(sniffImageMime(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif")
      expect(
        sniffImageMime(
          Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
        )
      ).toBe("image/webp")
      expect(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png")
    })

    it("returns the bytes as base64 PNG", async () => {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
      const clipboard = makeClipboard({ readImage: jest.fn(async () => bytes) })
      await expect(readClipboardImage(clipboard)).resolves.toEqual({
        ok: true,
        base64: bytesToBase64(bytes),
        mimeType: "image/png",
        byteLength: 4,
      })
    })

    it("answers ok:false when there is no image", async () => {
      await expect(readClipboardImage(makeClipboard())).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/no image/i),
      })
    })

    it("answers ok:false with the host error in a browser shell", async () => {
      const clipboard = makeClipboard({
        readImage: jest.fn(async () => {
          throw new Error("Browser clipboard image read is unavailable in this environment.")
        }),
      })
      await expect(readClipboardImage(clipboard)).resolves.toMatchObject({ ok: false })
    })
  })

  describe("clipboard_write_text / clipboard_clear", () => {
    it("writes the text and reports its length", async () => {
      const clipboard = makeClipboard()
      await expect(writeClipboardText(clipboard, "abc")).resolves.toEqual({ ok: true, length: 3 })
      expect(clipboard.writeText).toHaveBeenCalledWith("abc")
    })

    it("rejects a non-string payload without touching the clipboard", async () => {
      const clipboard = makeClipboard()
      await expect(writeClipboardText(clipboard, 42)).resolves.toMatchObject({ ok: false })
      expect(clipboard.writeText).not.toHaveBeenCalled()
    })

    it("clears through the host API", async () => {
      const clipboard = makeClipboard()
      await expect(clearClipboard(clipboard)).resolves.toEqual({ ok: true })
      expect(clipboard.clear).toHaveBeenCalledTimes(1)
    })

    it("tools forward the argument object to the host", async () => {
      const clipboard = makeClipboard()
      const [, , writeTool, clearTool] = createClipboardTools(clipboard)
      await expect(run(writeTool, { text: "x" })).resolves.toEqual({ ok: true, length: 1 })
      await expect(run(clearTool)).resolves.toEqual({ ok: true })
    })
  })

  describe("workflow nodes", () => {
    const step = (params: Record<string, unknown>) =>
      ({ runId: "r", workflowId: "w", stepId: "s", params, upstream: {} }) as never

    it("read node returns the same status the tool does", async () => {
      const clipboard = makeClipboard({
        hasText: jest.fn(async () => true),
        readText: jest.fn(async () => "workflow clipboard"),
      })
      const [readNode] = createClipboardWorkflowNodes(clipboard)
      await expect(readNode.execute(step({}))).resolves.toEqual({
        output: { ok: true, hasText: true, hasImage: false, content: "workflow clipboard" },
      })
    })

    it("write node writes params.text and clear node empties the clipboard", async () => {
      const clipboard = makeClipboard()
      const [, writeNode, clearNode] = createClipboardWorkflowNodes(clipboard)
      await expect(writeNode.execute(step({ text: "from node" }))).resolves.toEqual({
        output: { ok: true, length: 9 },
      })
      expect(clipboard.writeText).toHaveBeenCalledWith("from node")
      await expect(clearNode.execute(step({}))).resolves.toEqual({ output: { ok: true } })
      expect(clipboard.clear).toHaveBeenCalledTimes(1)
    })
  })

  it("bytesToBase64 survives payloads larger than one chunk", () => {
    const big = new Uint8Array(0x8000 * 2 + 7).fill(0x41)
    const expected = btoa(String.fromCharCode(...big.subarray(0, 0x8000))).slice(0, 8)
    expect(bytesToBase64(big).startsWith(expected)).toBe(true)
    expect(bytesToBase64(big).length).toBe(Math.ceil(big.length / 3) * 4)
  })
})
