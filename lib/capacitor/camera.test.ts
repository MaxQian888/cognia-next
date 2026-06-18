/**
 * @jest-environment jsdom
 */
import { pickMultiplePhotos, pickPhoto } from "./camera"

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

  it("proceeds for the prompt source when a checked permission is already granted", async () => {
    // The prompt source never triggers requestPermissions — it relies on the
    // existing checkPermissions result (camera "limited" counts as usable).
    const cam = makeCam({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "limited", photos: "denied" }),
    })
    const out = await pickPhoto({ source: "prompt", loader: async () => cam })
    expect(cam.requestPermissions).not.toHaveBeenCalled()
    expect(out).toMatchObject({ kind: "captured" })
  })

  it("returns permission_denied for the prompt source when neither is granted", async () => {
    const cam = makeCam({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "denied", photos: "denied" }),
    })
    const out = await pickPhoto({ source: "prompt", loader: async () => cam })
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
