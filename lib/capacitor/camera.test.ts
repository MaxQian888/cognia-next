/**
 * @jest-environment jsdom
 */
import { pickMultiplePhotos, pickPhoto } from "./camera"

jest.mock("./app", () => ({ subscribeRestoredResult: jest.fn(async () => () => {}) }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "camera-test-account" }) }))

describe("recoverable native capture", () => {
  it("persists destination before native launch and converts URI to requested base64", async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/jpeg" }),
    })) as unknown as typeof fetch
    const cam = makeCam({
      getPhoto: jest.fn(async () => {
        expect(localStorage.getItem("cognia.camera-recovery.v1")).toContain("origin-chat")
        return { webPath: "https://localhost/photo.jpg", format: "jpeg" }
      }),
    })
    try {
      const result = await pickPhoto({
        source: "camera",
        resultType: "base64",
        recoveryTarget: { kind: "chat", id: "origin-chat" },
        loader: async () => cam,
      })
      expect(cam.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ resultType: "uri" }))
      expect(result).toMatchObject({
        kind: "captured",
        base64: btoa("image"),
        uri: "https://localhost/photo.jpg",
      })
      expect(localStorage.getItem("cognia.camera-recovery.v1")).toBeNull()
    } finally {
      global.fetch = originalFetch
    }
  })

  it("clears the pending destination after native cancellation", async () => {
    const result = await pickPhoto({
      recoveryTarget: { kind: "chat", id: "origin-chat" },
      loader: async () =>
        makeCam({ getPhoto: jest.fn().mockRejectedValue(new Error("User cancelled")) }),
    })
    expect(result).toEqual({ kind: "cancelled" })
    expect(localStorage.getItem("cognia.camera-recovery.v1")).toBeNull()
  })
})

function makeCam(overrides: Record<string, unknown> = {}) {
  return {
    getPhoto: jest.fn().mockResolvedValue({
      base64String: "AAAA",
      webPath: "blob:..",
      format: "jpeg",
    }),
    pickImages: jest.fn().mockResolvedValue({
      photos: [{ webPath: "blob:1", format: "jpeg" }],
    }),
    requestPermissions: jest.fn().mockResolvedValue({ camera: "granted", photos: "granted" }),
    checkPermissions: jest.fn().mockResolvedValue({ camera: "granted", photos: "granted" }),
    ...overrides,
  } as {
    getPhoto: jest.Mock
    pickImages: jest.Mock
    requestPermissions: jest.Mock
    checkPermissions: jest.Mock
  }
}

describe("pickPhoto", () => {
  it("returns captured with base64 + uri + format", async () => {
    const cam = makeCam()
    const out = await pickPhoto({ source: "camera", loader: async () => cam })
    expect(out).toEqual({
      kind: "captured",
      base64: "AAAA",
      dataUrl: undefined,
      uri: "blob:..",
      format: "jpeg",
    })
  })

  it("forwards source mapping", async () => {
    const cam = makeCam()
    await pickPhoto({ source: "photos", loader: async () => cam })
    expect(cam.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ source: "PHOTOS" }))
  })

  it("requests permission and returns permission_denied if camera blocked", async () => {
    const cam = makeCam({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "prompt", photos: "granted" }),
      requestPermissions: jest.fn().mockResolvedValue({ camera: "denied", photos: "granted" }),
    })
    const out = await pickPhoto({ source: "camera", loader: async () => cam })
    expect(out).toEqual({ kind: "permission_denied" })
  })

  it("falls back to a file picker when the native plugin is absent", async () => {
    const file = new File(["hello"], "shot.png", { type: "image/png" })
    const picker = jest.fn().mockResolvedValue([file])
    const out = await pickPhoto({
      source: "camera",
      loader: async () => {
        throw new Error("nope")
      },
      picker,
    })
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ accept: "image/*", capture: "environment", multiple: false })
    )
    expect(out).toMatchObject({ kind: "captured", format: "png" })
    expect((out as { base64?: string }).base64).toBe(btoa("hello"))
  })

  it("uses the synchronous web fallback when no native Camera plugin is registered", async () => {
    // No `loader` override → the real defaultLoader is used. With no
    // window.Capacitor.Plugins.Camera, the activation-preserving fast path
    // must skip the rejecting dynamic import and call the picker directly.
    const file = new File(["hello"], "shot.png", { type: "image/png" })
    const picker = jest.fn().mockResolvedValue([file])
    const out = await pickPhoto({ source: "camera", picker })
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ accept: "image/*", capture: "environment", multiple: false })
    )
    expect(out).toMatchObject({ kind: "captured", format: "png" })
  })

  it("uses the native plugin when window.Capacitor.Plugins.Camera is present", async () => {
    const cam = makeCam()
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: { Camera: cam } }
    const picker = jest.fn()
    try {
      const out = await pickPhoto({ source: "camera", picker })
      expect(cam.getPhoto).toHaveBeenCalled()
      expect(picker).not.toHaveBeenCalled()
      expect(out).toMatchObject({ kind: "captured" })
    } finally {
      delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor
    }
  })

  it("does not pass capture for the photos source in the web fallback", async () => {
    const file = new File(["x"], "p.jpg", { type: "image/jpeg" })
    const picker = jest.fn().mockResolvedValue([file])
    await pickPhoto({
      source: "photos",
      loader: async () => {
        throw new Error("no native")
      },
      picker,
    })
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ capture: undefined }))
  })

  it("web fallback returns cancelled when no file is chosen", async () => {
    const out = await pickPhoto({
      loader: async () => {
        throw new Error("no native")
      },
      picker: async () => [],
    })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("web fallback returns dataUrl when resultType is dataUrl", async () => {
    const file = new File(["y"], "p.webp", { type: "image/webp" })
    const out = await pickPhoto({
      resultType: "dataUrl",
      loader: async () => {
        throw new Error("no native")
      },
      picker: async () => [file],
    })
    expect((out as { dataUrl?: string }).dataUrl).toMatch(/^data:image\/webp;base64,/)
  })

  it("web fallback surfaces picker errors", async () => {
    const out = await pickPhoto({
      loader: async () => {
        throw new Error("no native")
      },
      picker: async () => {
        throw new Error("picker boom")
      },
    })
    expect(out).toEqual({ kind: "error", message: "picker boom" })
  })

  it("web fallback returns an error outcome when the selected file cannot be read", async () => {
    const readSpy = jest.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
      this: FileReader
    ) {
      Object.defineProperty(this, "error", { value: new DOMException("file is unreadable") })
      queueMicrotask(() => this.dispatchEvent(new ProgressEvent("error")))
    })
    try {
      await expect(
        pickPhoto({ picker: async () => [new File(["photo"], "photo.png")] })
      ).resolves.toEqual({ kind: "error", message: "file is unreadable" })
    } finally {
      readSpy.mockRestore()
    }
  })

  it("default DOM picker resolves the chosen file on the change event", async () => {
    const file = new File(["zz"], "c.png", { type: "image/png" })
    const clickSpy = jest.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement
    ) {
      Object.defineProperty(this, "files", { value: [file], configurable: true })
      queueMicrotask(() => this.dispatchEvent(new Event("change")))
    })
    const out = await pickPhoto({
      source: "photos",
      loader: async () => {
        throw new Error("no native")
      },
    })
    expect(out).toMatchObject({ kind: "captured", format: "png" })
    expect(document.querySelector('input[type="file"]')).toBeNull() // input removed
    clickSpy.mockRestore()
  })

  it("default DOM picker resolves cancelled when the dialog is dismissed", async () => {
    const clickSpy = jest.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement
    ) {
      queueMicrotask(() => this.dispatchEvent(new Event("cancel")))
    })
    const out = await pickPhoto({
      source: "camera",
      loader: async () => {
        throw new Error("no native")
      },
    })
    expect(out).toEqual({ kind: "cancelled" })
    clickSpy.mockRestore()
  })

  it("treats getPhoto Cancel error as cancelled", async () => {
    const cam = makeCam({
      getPhoto: jest.fn().mockRejectedValue(new Error("User cancelled photos app")),
    })
    const out = await pickPhoto({ source: "camera", loader: async () => cam })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("returns error for non-cancel exceptions", async () => {
    const cam = makeCam({
      getPhoto: jest.fn().mockRejectedValue(new Error("storage full")),
    })
    const out = await pickPhoto({ source: "camera", loader: async () => cam })
    expect(out).toEqual({ kind: "error", message: "storage full" })
  })

  it("requests only the photos permission for the photos source", async () => {
    const cam = makeCam({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "denied", photos: "prompt" }),
      requestPermissions: jest.fn().mockResolvedValue({ camera: "denied", photos: "granted" }),
    })
    const out = await pickPhoto({ source: "photos", loader: async () => cam })
    expect(cam.requestPermissions).toHaveBeenCalledWith({ permissions: ["photos"] })
    expect(out).toMatchObject({ kind: "captured" })
  })

  it("proceeds for the prompt source when a checked permission is already usable", async () => {
    // camera "limited" counts as usable — no redundant re-prompt.
    const cam = makeCam({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "limited", photos: "denied" }),
    })
    const out = await pickPhoto({ source: "prompt", loader: async () => cam })
    expect(cam.requestPermissions).not.toHaveBeenCalled()
    expect(out).toMatchObject({ kind: "captured" })
  })

  it("requests both permissions for the prompt source on a fresh install", async () => {
    // Fresh install: both states are "prompt" — the OS dialog must be shown
    // (this used to dead-end at permission_denied without ever asking).
    const cam = makeCam({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "prompt", photos: "prompt" }),
      requestPermissions: jest.fn().mockResolvedValue({ camera: "denied", photos: "granted" }),
    })
    const out = await pickPhoto({ source: "prompt", loader: async () => cam })
    expect(cam.requestPermissions).toHaveBeenCalledWith({ permissions: ["camera", "photos"] })
    expect(out).toMatchObject({ kind: "captured" })
  })

  it("returns permission_denied for the prompt source when the user denies the request", async () => {
    const cam = makeCam({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "denied", photos: "denied" }),
      requestPermissions: jest.fn().mockResolvedValue({ camera: "denied", photos: "denied" }),
    })
    const out = await pickPhoto({ source: "prompt", loader: async () => cam })
    expect(cam.requestPermissions).toHaveBeenCalledWith({ permissions: ["camera", "photos"] })
    expect(out).toEqual({ kind: "permission_denied" })
  })

  it("forwards explicit capture options to the native plugin", async () => {
    const cam = makeCam()
    await pickPhoto({
      source: "camera",
      quality: 50,
      allowEditing: true,
      width: 100,
      height: 200,
      saveToGallery: true,
      resultType: "uri",
      loader: async () => cam,
    })
    expect(cam.getPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        quality: 50,
        allowEditing: true,
        width: 100,
        height: 200,
        saveToGallery: true,
        resultType: "uri",
      })
    )
  })
})

describe("pickMultiplePhotos", () => {
  it.each([
    [undefined, 9],
    [2, 2],
    [0, 12],
    [-1, 12],
  ])(
    "enforces native selection limit %s even when the system picker ignores it",
    async (limit, count) => {
      const photos = Array.from({ length: 12 }, (_, index) => ({
        webPath: `native:${index}`,
        format: "jpeg",
      }))
      const cam = makeCam({ pickImages: jest.fn().mockResolvedValue({ photos }) })
      const out = await pickMultiplePhotos({ limit, loader: async () => cam })
      expect(out).toEqual({
        kind: "picked",
        photos: photos
          .slice(0, count)
          .map((photo) => ({ uri: photo.webPath, format: photo.format })),
      })
    }
  )

  it.each([
    [undefined, 9],
    [2, 2],
    [0, 12],
    [-1, 12],
  ])("enforces web selection limit %s before allocating photo URLs", async (limit, count) => {
    const original = URL.createObjectURL
    URL.createObjectURL = jest.fn((file: Blob) => `blob:${(file as File).name}`)
    const files = Array.from(
      { length: 12 },
      (_, index) => new File([String(index)], `${index}.png`, { type: "image/png" })
    )
    try {
      const out = await pickMultiplePhotos({ limit, picker: async () => files })
      expect(out).toEqual({
        kind: "picked",
        photos: files.slice(0, count).map((file) => ({ uri: `blob:${file.name}`, format: "png" })),
      })
      expect(URL.createObjectURL).toHaveBeenCalledTimes(count)
    } finally {
      URL.createObjectURL = original
    }
  })

  it("enforces the web limit after native loading fails", async () => {
    const out = await pickMultiplePhotos({
      limit: 1,
      loader: async () => {
        throw new Error("missing plugin")
      },
      picker: async () => [new File(["a"], "a.png"), new File(["b"], "b.png")],
    })
    expect(out.kind).toBe("picked")
    if (out.kind === "picked") expect(out.photos).toHaveLength(1)
  })

  it("returns picked photos with uri + format", async () => {
    const cam = makeCam()
    const out = await pickMultiplePhotos({ loader: async () => cam })
    expect(out).toEqual({
      kind: "picked",
      photos: [{ uri: "blob:1", format: "jpeg" }],
    })
  })

  it("returns cancelled when zero photos", async () => {
    const cam = makeCam({
      pickImages: jest.fn().mockResolvedValue({ photos: [] }),
    })
    const out = await pickMultiplePhotos({ loader: async () => cam })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("treats a pickImages cancel error as cancelled", async () => {
    const cam = makeCam({
      pickImages: jest.fn().mockRejectedValue(new Error("User cancelled photos app")),
    })
    const out = await pickMultiplePhotos({ loader: async () => cam })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("returns error for non-cancel pickImages exceptions", async () => {
    const cam = makeCam({
      pickImages: jest.fn().mockRejectedValue(new Error("disk full")),
    })
    const out = await pickMultiplePhotos({ loader: async () => cam })
    expect(out).toEqual({ kind: "error", message: "disk full" })
  })

  it("falls back to a multi-file picker when the native plugin is absent", async () => {
    // jsdom has no URL.createObjectURL — stub it so objectUrlFor returns a uri.
    const urlRef = URL as unknown as { createObjectURL?: (b: Blob) => string }
    const original = urlRef.createObjectURL
    urlRef.createObjectURL = jest.fn(() => "blob:stub")
    try {
      const files = [
        new File(["a"], "a.png", { type: "image/png" }),
        new File(["b"], "b.jpg", { type: "image/jpeg" }),
      ]
      const picker = jest.fn().mockResolvedValue(files)
      const out = await pickMultiplePhotos({
        loader: async () => {
          throw new Error("no native")
        },
        picker,
      })
      expect(picker).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }))
      expect(out).toEqual({
        kind: "picked",
        photos: [
          { uri: "blob:stub", format: "png" },
          { uri: "blob:stub", format: "jpeg" },
        ],
      })
    } finally {
      urlRef.createObjectURL = original
    }
  })

  it("uses the synchronous multi web fallback when no native Camera plugin is registered", async () => {
    const urlRef = URL as unknown as { createObjectURL?: (b: Blob) => string }
    const original = urlRef.createObjectURL
    urlRef.createObjectURL = jest.fn(() => "blob:stub")
    try {
      const picker = jest.fn().mockResolvedValue([new File(["a"], "a.png", { type: "image/png" })])
      const out = await pickMultiplePhotos({ picker })
      expect(picker).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }))
      expect(out).toEqual({ kind: "picked", photos: [{ uri: "blob:stub", format: "png" }] })
    } finally {
      urlRef.createObjectURL = original
    }
  })

  it("uses the native plugin for multi when window.Capacitor.Plugins.Camera is present", async () => {
    const cam = makeCam()
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: { Camera: cam } }
    const picker = jest.fn()
    try {
      const out = await pickMultiplePhotos({ picker })
      expect(cam.pickImages).toHaveBeenCalled()
      expect(picker).not.toHaveBeenCalled()
      expect(out).toMatchObject({ kind: "picked" })
    } finally {
      delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor
    }
  })

  it("web multi fallback returns cancelled with no files", async () => {
    const out = await pickMultiplePhotos({
      loader: async () => {
        throw new Error("no native")
      },
      picker: async () => [],
    })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("web multi fallback surfaces picker errors", async () => {
    const out = await pickMultiplePhotos({
      loader: async () => {
        throw new Error("no native")
      },
      picker: async () => {
        throw new Error("multi boom")
      },
    })
    expect(out).toEqual({ kind: "error", message: "multi boom" })
  })
})
