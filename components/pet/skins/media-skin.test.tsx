import { generateBones } from "@/lib/pet/bones/generate"
import { act, render, waitFor } from "@testing-library/react"
import { MediaCanvas, mediaSkin } from "./media-skin"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"
import { loadMediaSkinAsset } from "@/lib/pet/media-packs/asset-bridge"
import type { MediaPackAsset } from "@/lib/pet/media-packs/manifest"
import type { PetSkinRenderProps } from "@/types/pet"
jest.mock("@/lib/pet/media-packs/asset-bridge", () => ({ loadMediaSkinAsset: jest.fn() }))
jest.mock("./svg-skin", () => ({
  svgSkin: { render: () => <div role="img" aria-label="fallback" /> },
}))
const asset: MediaPackAsset = {
  id: "mp_test",
  manifest: {
    version: 1,
    displayName: "Whale",
    source: "dsh-frames",
    width: 2,
    height: 2,
    clips: {
      idle: {
        kind: "atlas",
        file: "sheet.png",
        frameWidth: 2,
        frameHeight: 2,
        columns: 2,
        frameCount: 3,
        frameMs: 42,
        loop: true,
      },
    },
    states: { idle: ["idle"] },
    ambient: [],
  },
  entries: [{ path: "sheet.png", blob: new Blob(["png"]) }],
  totalBytes: 3,
  createdAt: 0,
}
const clip = asset.manifest.clips.idle as Exclude<
  typeof asset.manifest.clips.idle,
  { kind: "video" }
>
const drawImage = jest.fn(),
  callbacks = new Map<number, FrameRequestCallback>()
let next = 0
const originals = {
  Image: globalThis.Image,
  raf: globalThis.requestAnimationFrame,
  cancel: globalThis.cancelAnimationFrame,
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
}
beforeEach(() => {
  URL.revokeObjectURL = jest.fn()
  resetPetSkinRuntimeForTests()
  callbacks.clear()
  next = 0
  drawImage.mockClear()
  jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ clearRect: jest.fn(), drawImage } as never)
  jest
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/png;base64,frame")
  globalThis.Image = class {
    onload?: () => void
    onerror?: () => void
    complete = true
    naturalWidth = 4
    naturalHeight = 4
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  } as unknown as typeof Image
  globalThis.requestAnimationFrame = jest.fn((callback) => {
    callbacks.set(++next, callback)
    return next
  })
  globalThis.cancelAnimationFrame = jest.fn((id) => callbacks.delete(id))
  URL.createObjectURL = jest.fn(() => "blob:frame")
  URL.revokeObjectURL = jest.fn()
  jest.mocked(loadMediaSkinAsset).mockResolvedValue(asset)
})
afterEach(() => {
  jest.restoreAllMocks()
  globalThis.Image = originals.Image
  globalThis.requestAnimationFrame = originals.raf
  globalThis.cancelAnimationFrame = originals.cancel
  URL.createObjectURL = originals.create
  URL.revokeObjectURL = originals.revoke
})
async function tick(time: number) {
  await act(async () => {
    const [id, callback] = [...callbacks][0]
    callbacks.delete(id)
    callback(time)
    await Promise.resolve()
  })
}

it("decodes ordered WebP frames through separate image URLs", async () => {
  const frames: MediaPackAsset = {
    ...asset,
    entries: ["a.webp", "b.webp"].map((path) => ({ path, blob: new Blob([path]) })),
    totalBytes: 12,
  }
  const ordered = { kind: "frames" as const, frames: ["b.webp", "a.webp"], frameMs: 42, loop: true }
  render(
    <MediaCanvas
      asset={frames}
      clip={ordered}
      size={256}
      reducedMotion={false}
      onEnded={jest.fn()}
      onError={jest.fn()}
    />
  )
  await act(async () => {
    await Promise.resolve()
  })
  await tick(0)
  await tick(42)
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
  expect(jest.mocked(URL.createObjectURL).mock.calls[0][0]).toBe(frames.entries[1].blob)
  expect(jest.mocked(URL.createObjectURL).mock.calls[1][0]).toBe(frames.entries[0].blob)
  expect(drawImage).toHaveBeenCalledTimes(2)
})

it("returns one-shots to idle, rotates ambient clips and respects noMirror", async () => {
  const single = { ...clip, frameCount: 1, frameMs: 42 }
  const sequence: MediaPackAsset = {
    ...asset,
    manifest: {
      ...asset.manifest,
      clips: {
        idle: single,
        touch: { ...single, loop: false, noMirror: true },
        stretch: { ...single, loop: false },
      },
      states: { idle: ["idle"], pet: ["touch"] },
      ambient: ["stretch"],
    },
  }
  jest.mocked(loadMediaSkinAsset).mockResolvedValue(sequence)
  const props = {
    bones: generateBones("media-test"),
    stage: "baby",
    state: "idle",
    oneShot: "petted",
    reducedMotion: false,
    size: 256,
    selection: { skinId: "media", packId: asset.id },
    locomotion: { mode: "resting", facing: "left" },
  } as PetSkinRenderProps
  const view = render(<>{mediaSkin.render(props)}</>)
  await waitFor(() =>
    expect(view.container.querySelector('[data-media-clip="touch"]')).toBeInTheDocument()
  )
  expect(
    (view.container.querySelector('[data-media-clip="touch"]') as HTMLElement).style.transform
  ).toBe("")
  await tick(0)
  await tick(42)
  expect(view.container.querySelector('[data-media-clip="idle"]')).toBeInTheDocument()
  expect(
    (view.container.querySelector('[data-media-clip="idle"]') as HTMLElement).style.transform
  ).toBe("scaleX(-1)")
  for (let i = 1; i <= 3; i++) {
    await tick(i * 100)
    await tick(i * 100 + 42)
  }
  expect(view.container.querySelector('[data-media-clip="stretch"]')).toBeInTheDocument()
  await tick(500)
  await tick(542)
  expect(view.container.querySelector('[data-media-clip="idle"]')).toBeInTheDocument()
})
it("draws actual atlas cells by elapsed time and completes without a leaked ticker", async () => {
  const ended = jest.fn(),
    error = jest.fn()
  const { unmount } = render(
    <MediaCanvas
      asset={asset}
      clip={clip}
      size={256}
      reducedMotion={false}
      onEnded={ended}
      onError={error}
    />
  )
  await act(async () => {
    await Promise.resolve()
  })
  await tick(0)
  await tick(84)
  expect(drawImage.mock.calls.at(-1)?.slice(1, 5)).toEqual([0, 2, 2, 2])
  await tick(126)
  expect(ended).toHaveBeenCalledTimes(1)
  expect(error).not.toHaveBeenCalled()
  expect(getPetSkinRuntime().diagnostics().tickers).toBe(0)
  unmount()
  expect(callbacks.size).toBe(0)
})
it("freezes on pause, resumes its frame clock, and renders a still without RAF for reduced motion", async () => {
  const props = {
    asset,
    clip,
    size: 256,
    reducedMotion: false,
    onEnded: jest.fn(),
    onError: jest.fn(),
  }
  const { rerender } = render(<MediaCanvas {...props} />)
  await act(async () => {
    await Promise.resolve()
  })
  await tick(0)
  await tick(84)
  rerender(<MediaCanvas {...props} paused />)
  await act(async () => {
    await Promise.resolve()
  })
  expect(callbacks.size).toBe(0)
  expect(drawImage.mock.calls.at(-1)?.slice(1, 5)).toEqual([0, 2, 2, 2])
  rerender(<MediaCanvas {...props} />)
  await tick(1000)
  expect(getPetSkinRuntime().diagnostics().tickers).toBe(1)
  rerender(<MediaCanvas {...props} reducedMotion />)
  expect(callbacks.size).toBe(0)
  expect(getPetSkinRuntime().diagnostics().tickers).toBe(0)
})
it("loads the selected media through the registered skin and recovers after an explicit retry", async () => {
  jest.mocked(loadMediaSkinAsset).mockResolvedValueOnce(undefined)
  const props = {
    bones: generateBones("media-test"),
    stage: "baby",
    state: "idle",
    oneShot: null,
    reducedMotion: true,
    size: 256,
    selection: { skinId: "media", packId: asset.id },
  } as PetSkinRenderProps
  const view = render(<>{mediaSkin.render(props)}</>)
  await waitFor(() =>
    expect(getPetSkinRuntime().assetDiagnostic(`media:${asset.id}`)?.code).toBe("assetMissing")
  )
  expect(view.getByRole("img", { name: "fallback" })).toBeVisible()
  act(() => getPetSkinRuntime().retryAsset(`media:${asset.id}`))
  await waitFor(() => expect(view.container.querySelector("canvas")).toBeInTheDocument())
})
