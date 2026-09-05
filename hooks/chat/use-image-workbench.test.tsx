import { act, renderHook, waitFor } from "@testing-library/react"

import { createPixelBuffer, ImageDecodeError, type PixelBuffer } from "@/lib/images"

import {
  useImageWorkbench,
  __clearWorkbenchCheckpointCacheForTests,
  type ImageWorkbenchSource,
  type WorkbenchDeps,
} from "./use-image-workbench"

function opaque(width: number, height: number, value = 100): PixelBuffer {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) {
    buffer.data[i] = value
    buffer.data[i + 1] = value
    buffer.data[i + 2] = value
    buffer.data[i + 3] = 255
  }
  return buffer
}

const source: ImageWorkbenchSource = {
  url: "blob:origin",
  mediaType: "image/png",
  filename: "photo.png",
  lineageId: "cognia-media:origin",
  parentVersionId: null,
}

const target = { sessionId: "s1", messageId: "m1", canSave: true }

const capability = { providerId: "openai" as const, modelId: "gpt-image-1", supportsMask: true }

let objectUrls = 0
const revoked: string[] = []

function makeDeps(overrides: Partial<WorkbenchDeps> = {}): Partial<WorkbenchDeps> {
  return {
    decode: jest.fn(async () => opaque(40, 20)),
    toBlob: jest.fn(async () => new Blob(["png"], { type: "image/png" })),
    encode: jest.fn(async () => ({ bytes: new Uint8Array([1]), mediaType: "image/webp" })),
    maskToProvider: jest.fn(async () => ({
      bytes: new Uint8Array([2]),
      mediaType: "image/png",
    })),
    capabilities: jest.fn(() => ({
      options: [capability],
      preferred: capability,
      unavailable: null,
    })),
    edit: jest.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array([3]),
      mediaType: "image/png",
      providerId: "openai",
      modelId: "gpt-image-1",
      operation: "ai.prompt" as const,
    })),
    save: jest.fn(async () => ({
      appended: true,
      ref: "cognia-media:edited",
      version: {} as never,
    })),
    ...overrides,
  }
}

beforeEach(() => {
  __clearWorkbenchCheckpointCacheForTests()
  objectUrls = 0
  revoked.length = 0
  globalThis.URL.createObjectURL = jest.fn(() => `blob:made-${(objectUrls += 1)}`)
  globalThis.URL.revokeObjectURL = jest.fn((url: string) => {
    revoked.push(url)
  })
})

function mount(deps: Partial<WorkbenchDeps>) {
  return renderHook(
    (props: { source: ImageWorkbenchSource | null }) =>
      useImageWorkbench({ source: props.source, target, enabled: true, deps }),
    { initialProps: { source } }
  )
}

describe("decoding", () => {
  it("becomes ready with a preview and the source-pixel size", async () => {
    const { result } = mount(makeDeps())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.previewUrl).toMatch(/^blob:made-/)
    expect(result.current.size).toEqual({ width: 40, height: 20 })
  })

  it("reports a cross-origin image as blocked rather than broken", async () => {
    // The image renders and downloads fine. Only editing is impossible, and
    // the panel has to say which of the two it is.
    const deps = makeDeps({
      decode: jest.fn(async () => {
        throw new ImageDecodeError("cors", "tainted")
      }),
    })
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.blocked).toBe("cors")
  })

  it("reports an undecodable image as a decode failure", async () => {
    const deps = makeDeps({
      decode: jest.fn(async () => {
        throw new Error("nope")
      }),
    })
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.blocked).toBe("decode"))
  })

  it("renders the preview from a downscaled copy of a large image", async () => {
    // A 1568px frame cannot be tone-adjusted at slider speed, so the preview
    // works smaller while the reported size stays the real one.
    const deps = makeDeps({ decode: jest.fn(async () => opaque(1800, 900)) })
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.size).toEqual({ width: 1800, height: 900 })
    const rendered = (deps.toBlob as jest.Mock).mock.calls[0][0] as PixelBuffer
    expect(Math.max(rendered.width, rendered.height)).toBeLessThanOrEqual(900)
  })
})

describe("history", () => {
  it("reports the size a crop will produce", async () => {
    const { result } = mount(makeDeps())
    await waitFor(() => expect(result.current.status).toBe("ready"))

    act(() => {
      result.current.apply({ kind: "crop", rect: { x: 0, y: 0, width: 20, height: 10 } })
    })
    await waitFor(() => expect(result.current.size).toEqual({ width: 20, height: 10 }))
    expect(result.current.isDirty).toBe(true)
    expect(result.current.canUndo).toBe(true)
  })

  it("undoes and redoes", async () => {
    const { result } = mount(makeDeps())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.apply({ kind: "rotate", turns: 1 }))
    await waitFor(() => expect(result.current.size).toEqual({ width: 20, height: 40 }))
    act(() => result.current.undo())
    await waitFor(() => expect(result.current.size).toEqual({ width: 40, height: 20 }))
    expect(result.current.canRedo).toBe(true)
    act(() => result.current.redo())
    await waitFor(() => expect(result.current.size).toEqual({ width: 20, height: 40 }))
  })

  it("resets back to the untouched image", async () => {
    const { result } = mount(makeDeps())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.apply({ kind: "rotate", turns: 1 }))
    act(() => result.current.reset())
    await waitFor(() => expect(result.current.isDirty).toBe(false))
  })

  it("starts a fresh history when a different image is opened", async () => {
    // Carrying the previous history over would replay one image's crop on
    // another one.
    const { result, rerender } = mount(makeDeps())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.apply({ kind: "rotate", turns: 1 }))
    expect(result.current.isDirty).toBe(true)

    rerender({ source: { ...source, url: "blob:other" } })
    expect(result.current.isDirty).toBe(false)
    expect(result.current.canUndo).toBe(false)
  })
})

describe("compare", () => {
  it("exposes the untouched source alongside the current render", async () => {
    const { result } = mount(makeDeps())
    await waitFor(() => expect(result.current.originalUrl).toBeTruthy())
    expect(result.current.originalUrl).not.toBe(result.current.previewUrl)
  })

  it("revokes the object URLs it created when it unmounts", async () => {
    const { result, unmount } = mount(makeDeps())
    await waitFor(() => expect(result.current.previewUrl).toBeTruthy())
    const preview = result.current.previewUrl
    unmount()
    expect(revoked).toContain(preview)
  })
})

describe("ai", () => {
  it("offers the resolved capabilities and preselects the preferred one", async () => {
    const { result } = mount(makeDeps())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.ai.capability).toEqual(capability)
    expect(result.current.ai.capabilities.options).toHaveLength(1)
  })

  it("sends the CURRENT render to the model, not the original", async () => {
    // The user asked the model to change what they can see, which includes
    // every local step applied so far.
    const deps = makeDeps()
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.apply({ kind: "rotate", turns: 1 }))
    await waitFor(() => expect(result.current.size).toEqual({ width: 20, height: 40 }))

    await act(async () => {
      await result.current.ai.run({ kind: "prompt", prompt: "make it blue" })
    })

    const encoded = (deps.encode as jest.Mock).mock.calls[0][0] as PixelBuffer
    expect(encoded.width).toBe(20)
    expect(encoded.height).toBe(40)
  })

  it("records the result as a checkpoint carrying its attribution", async () => {
    const { result } = mount(makeDeps())
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => {
      await result.current.ai.run({ kind: "prompt", prompt: "p" })
    })
    const entries = result.current.state.entries
    expect(entries.at(-1)).toMatchObject({
      kind: "ai",
      operation: "ai.prompt",
      providerId: "openai",
      modelId: "gpt-image-1",
    })
  })

  it("surfaces a refusal instead of appending a step", async () => {
    const deps = makeDeps({
      edit: jest.fn(async () => ({
        ok: false as const,
        code: "mask-unsupported" as const,
        message: "no mask here",
        retryable: false,
      })),
    })
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => {
      await result.current.ai.run({ kind: "prompt", prompt: "p" })
    })
    expect(result.current.ai.error).toMatchObject({ code: "mask-unsupported", retryable: false })
    expect(result.current.state.entries).toHaveLength(0)
  })

  it("rasterizes the brush strokes at the size the model will see", async () => {
    const deps = makeDeps()
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => {
      await result.current.ai.runRegion("erase the sign", [
        { mode: "add", radius: 4, hardness: 1, points: [{ x: 10, y: 5 }] },
      ])
    })
    const mask = (deps.maskToProvider as jest.Mock).mock.calls[0][0] as PixelBuffer
    expect(mask).toMatchObject({ width: 40, height: 20 })
    expect((deps.edit as jest.Mock).mock.calls[0][0].intent.kind).toBe("region")
  })

  it("does nothing when no provider is available", async () => {
    const deps = makeDeps({
      capabilities: jest.fn(() => ({
        options: [],
        preferred: null,
        unavailable: { reason: "no-provider" as const },
      })),
    })
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => {
      await result.current.ai.run({ kind: "prompt", prompt: "p" })
    })
    expect(deps.edit).not.toHaveBeenCalled()
    expect(result.current.ai.capabilities.unavailable?.reason).toBe("no-provider")
  })
})

describe("save", () => {
  it("stores the full-resolution render with its operations and attribution", async () => {
    const deps = makeDeps({ decode: jest.fn(async () => opaque(1800, 900)) })
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.apply({ kind: "rotate", turns: 1 }))
    await waitFor(() => expect(result.current.size).toEqual({ width: 900, height: 1800 }))

    await act(async () => {
      await result.current.save.run()
    })

    const encoded = (deps.encode as jest.Mock).mock.calls.at(-1)?.[0] as PixelBuffer
    // The preview renders small. The save must not.
    expect(Math.max(encoded.width, encoded.height)).toBe(1800)
    expect((deps.save as jest.Mock).mock.calls[0][0]).toMatchObject({
      sessionId: "s1",
      messageId: "m1",
      lineageId: "cognia-media:origin",
      parentVersionId: null,
      operations: ["rotate"],
      filename: "photo.png",
    })
  })

  it("reuses the version id after a failure, so a retry is one version", async () => {
    let attempt = 0
    const deps = makeDeps({
      save: jest.fn(async () => {
        attempt += 1
        if (attempt === 1) throw new Error("offline")
        return { appended: true, ref: "r", version: {} as never }
      }),
    })
    const { result } = mount(deps)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    act(() => result.current.apply({ kind: "rotate", turns: 1 }))

    await act(async () => {
      expect(await result.current.save.run()).toBe(false)
    })
    expect(result.current.save.error).toBe("offline")

    await act(async () => {
      expect(await result.current.save.run()).toBe(true)
    })
    const calls = (deps.save as jest.Mock).mock.calls
    expect(calls[0][0].versionId).toBe(calls[1][0].versionId)
  })

  it("refuses to save into a session that cannot be written", async () => {
    const deps = makeDeps()
    const { result } = renderHook(() =>
      useImageWorkbench({
        source,
        target: { ...target, canSave: false },
        enabled: true,
        deps,
      })
    )
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await act(async () => {
      expect(await result.current.save.run()).toBe(false)
    })
    expect(deps.save).not.toHaveBeenCalled()
  })
})

describe("disabled", () => {
  it("decodes nothing while the dialog is closed", async () => {
    const deps = makeDeps()
    renderHook(() => useImageWorkbench({ source, target, enabled: false, deps }))
    expect(deps.decode).not.toHaveBeenCalled()
    expect(deps.capabilities).not.toHaveBeenCalled()
  })
})
