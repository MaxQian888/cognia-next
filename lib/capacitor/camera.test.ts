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

  it("returns unsupported when plugin not loadable", async () => {
    const out = await pickPhoto({
      loader: async () => {
        throw new Error("nope")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
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
})
