import { isMirroredSettingsClient, mirrorSettingsPatchToHost } from "./mirror-to-host"

jest.mock("@/lib/platform/detect", () => ({ isCapacitor: jest.fn(() => false) }))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: jest.fn(() => false) }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn() }))

import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

const mockIsCapacitor = isCapacitor as jest.MockedFunction<typeof isCapacitor>
const mockHasWebCompanion = hasWebCompanionTarget as jest.MockedFunction<
  typeof hasWebCompanionTarget
>

describe("isMirroredSettingsClient", () => {
  beforeEach(() => {
    mockIsCapacitor.mockReturnValue(false)
    mockHasWebCompanion.mockReturnValue(false)
  })

  it("is false on the desktop, which owns its own settings row", () => {
    expect(isMirroredSettingsClient()).toBe(false)
  })

  it("is true on a Capacitor phone", () => {
    mockIsCapacitor.mockReturnValue(true)
    expect(isMirroredSettingsClient()).toBe(true)
  })

  it("is true in a browser pointed at a cloud server", () => {
    mockHasWebCompanion.mockReturnValue(true)
    expect(isMirroredSettingsClient()).toBe(true)
  })
})

describe("mirrorSettingsPatchToHost", () => {
  let enqueueJob: jest.Mock

  beforeEach(() => {
    enqueueJob = jest.fn().mockResolvedValue(undefined)
  })

  // Built per call, not once: `enqueueJob` is replaced in `beforeEach`, so a
  // hoisted object would keep handing the module the previous spy.
  const mirrored = () => ({ enqueueJob, isMirrored: () => true })

  it("enqueues nothing when this runtime owns its settings", async () => {
    const keys = await mirrorSettingsPatchToHost(
      { theme: "dark" },
      { enqueueJob, isMirrored: () => false }
    )
    expect(keys).toEqual([])
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("enqueues one app_settings_update carrying the writable keys", async () => {
    const keys = await mirrorSettingsPatchToHost({ theme: "dark", fontScale: "lg" }, mirrored())

    expect(keys).toEqual(["theme", "fontScale"])
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "app_settings_update",
        payload: { patch: { theme: "dark", fontScale: "lg" } },
      })
    )
  })

  it("mirrors the appearance keys the embedded desktop section writes", async () => {
    // The regression this module exists for: `/me/appearance` embeds the
    // desktop `<AppearanceSection />`, which writes these through the store.
    // They were allowlisted server-side but nothing ever sent them.
    const patch = {
      colorTheme: "nord",
      accentColor: "#ff0000",
      customCss: ".x{}",
      customCssEnabled: true,
    }
    const keys = await mirrorSettingsPatchToHost(patch as never, mirrored())
    expect(new Set(keys)).toEqual(new Set(Object.keys(patch)))
  })

  it("drops non-writable keys instead of letting them fail the whole patch", async () => {
    // The host rejects a patch outright if any key is disallowed, so sending a
    // mixed patch would lose the writable half too.
    const keys = await mirrorSettingsPatchToHost(
      { theme: "dark", apiKey: "sk-secret", defaultWorkingDir: "/tmp" } as never,
      mirrored()
    )

    expect(keys).toEqual(["theme"])
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { patch: { theme: "dark" } } })
    )
    expect(JSON.stringify(enqueueJob.mock.calls)).not.toContain("sk-secret")
  })

  it("stays quiet when nothing in the patch is writable", async () => {
    const keys = await mirrorSettingsPatchToHost({ apiKey: "sk-secret" } as never, mirrored())
    expect(keys).toEqual([])
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("does not mirror the device-local keys that only mean something here", async () => {
    // Pushing one device's biometric policy, microphone id or editor
    // performance tier onto another is wrong rather than merely useless.
    const keys = await mirrorSettingsPatchToHost(
      {
        biometricRequiredFor: { unlock: true },
        selectedMicId: "mic-1",
        workflowEditorPerformanceTier: "high",
        webrtcEnabled: false,
      } as never,
      mirrored()
    )
    expect(keys).toEqual([])
  })

  it("keeps the wallpaper library on the handset that holds its bytes", async () => {
    // `/me/appearance` embeds the desktop wallpaper tab, so a phone can and
    // does upload wallpapers — but off Tauri `saveImage()` can only write an
    // `indexeddb` blobKey, which addresses this webview's blob store and
    // nothing else. Mirroring the array up put rows in the desktop's gallery
    // that it could not open, and activating one switched the background off.
    const keys = await mirrorSettingsPatchToHost(
      {
        wallpapers: [
          {
            id: "w1",
            name: "Sunset",
            kind: "image",
            builtin: false,
            createdAt: 1,
            source: {
              kind: "image",
              storage: "indexeddb",
              blobKey: "w1",
              mime: "image/png",
              width: 4,
              height: 3,
            },
          },
        ],
      } as never,
      mirrored()
    )
    expect(keys).toEqual([])
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("does not mirror transport config, which flows the other way", async () => {
    const keys = await mirrorSettingsPatchToHost(
      {
        signalingUrl: "wss://example/signaling",
        iceServers: [],
        turnServers: [],
        turnProvider: { kind: "none" },
      } as never,
      mirrored()
    )
    expect(keys).toEqual([])
  })
})
