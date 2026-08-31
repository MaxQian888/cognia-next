import { act, cleanup, render, screen } from "@testing-library/react"
import type { PetSkinRenderProps } from "@/types/pet"

const loadSpriteSkinAsset = jest.fn()
jest.mock("@/lib/pet/skin-assets", () => ({
  loadSpriteSkinAsset: (...args: unknown[]) => loadSpriteSkinAsset(...args),
}))
jest.mock("./svg-skin", () => ({
  svgSkin: { id: "svg", render: () => <div data-testid="sprite-fallback" /> },
}))

import { resolveSpriteAnimation, spriteV2Skin } from "./sprite-v2-skin"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"

const props: PetSkinRenderProps = {
  bones: {} as never,
  stage: "adult",
  state: "idle",
  oneShot: null,
  reducedMotion: false,
  size: 104,
  selection: { skinId: "sprite-v2", packId: "momo" },
}

describe("spriteV2Skin", () => {
  beforeEach(() => {
    resetPetSkinRuntimeForTests()
    jest.useFakeTimers()
    loadSpriteSkinAsset.mockResolvedValue({
      id: "momo",
      spritesheet: new Blob(["atlas"], { type: "image/webp" }),
    })
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: jest.fn(() => "blob:sprite"),
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: jest.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    jest.clearAllTimers()
    jest.useRealTimers()
    resetPetSkinRuntimeForTests()
  })

  it("maps Cognia states and locomotion to the standard v2 rows", () => {
    for (const [state, row] of [
      ["idle", 0],
      ["sleeping", 0],
      ["waiting", 6],
      ["review", 8],
      ["thinking", 7],
      ["interacting", 7],
      ["evolving", 7],
      ["error", 5],
      ["sad", 5],
      ["unwell", 5],
      ["greeting", 3],
      ["happy", 4],
    ] as const) {
      expect(resolveSpriteAnimation({ ...props, state }).row).toBe(row)
    }
    for (const [oneShot, row] of [
      ["wave", 3],
      ["sad", 5],
      ["happy", 4],
      ["levelUp", 4],
      ["evolving", 4],
      ["surprised", 4],
      ["land", 4],
      ["hatch", 4],
    ] as const) {
      expect(resolveSpriteAnimation({ ...props, oneShot }).row).toBe(row)
    }
    expect(
      resolveSpriteAnimation({ ...props, locomotion: { mode: "walking", facing: "left" } }).row
    ).toBe(2)
    expect(
      resolveSpriteAnimation({ ...props, locomotion: { mode: "walking", facing: "right" } }).row
    ).toBe(1)
    expect(
      resolveSpriteAnimation({ ...props, locomotion: { mode: "climbing", facing: "right" } }).row
    ).toBe(1)
    expect(
      resolveSpriteAnimation({ ...props, locomotion: { mode: "falling", facing: "left" } }).row
    ).toBe(4)
  })

  it("renders the installed atlas and advances frames", async () => {
    render(<>{spriteV2Skin.render(props)}</>)
    await act(async () => Promise.resolve())
    const sprite = screen.getByTestId("pet-sprite-v2")
    expect(sprite).toHaveStyle({ backgroundImage: "url(blob:sprite)" })
    expect(sprite.style.backgroundPosition).toBe("0px 0px")

    act(() => jest.advanceTimersByTime(280))
    expect(sprite.style.backgroundPosition).toContain("-96px")
  })

  it("honors reduced motion and keeps the runtime-cached object URL on unmount", async () => {
    const { unmount } = render(<>{spriteV2Skin.render({ ...props, reducedMotion: true })}</>)
    await act(async () => Promise.resolve())
    const sprite = screen.getByTestId("pet-sprite-v2")

    act(() => jest.advanceTimersByTime(1_000))
    expect(sprite.style.backgroundPosition).toBe("0px 0px")

    unmount()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it("keeps the current frame while paused", async () => {
    render(<>{spriteV2Skin.render({ ...props, paused: true })}</>)
    await act(async () => Promise.resolve())
    const sprite = screen.getByTestId("pet-sprite-v2")
    act(() => jest.advanceTimersByTime(1_000))
    expect(sprite.style.backgroundPosition).toBe("0px 0px")
  })

  it("uses shared visible fallbacks for held, speaking, mood, and flavor", async () => {
    render(
      <>
        {spriteV2Skin.render({
          ...props,
          held: true,
          speaking: true,
          mood: "lonely",
          flavor: "radiant",
        })}
      </>
    )
    await act(async () => Promise.resolve())
    const sprite = screen.getByTestId("pet-sprite-v2")
    expect(sprite).toHaveStyle({ transform: "rotate(7deg) translateY(3%)" })
    expect(sprite.style.filter).toContain("brightness(1.08)")
    expect(sprite.parentElement).toHaveAttribute("data-pet-speaking", "true")
    expect(sprite.parentElement).toHaveAttribute("data-pet-mood", "lonely")
  })

  it("uses the SVG fallback when the configured pack is missing", async () => {
    loadSpriteSkinAsset.mockResolvedValue(undefined)
    render(
      <>
        {spriteV2Skin.render({ ...props, selection: { skinId: "sprite-v2", packId: "missing" } })}
      </>
    )
    await act(async () => Promise.resolve())
    expect(screen.getByTestId("sprite-fallback")).toBeInTheDocument()
  })

  it("reloads a missing pack after the runtime retry action", async () => {
    loadSpriteSkinAsset.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: "momo",
      spritesheet: new Blob(["atlas"], { type: "image/webp" }),
    })
    render(<>{spriteV2Skin.render(props)}</>)
    await act(async () => Promise.resolve())
    expect(screen.getByTestId("sprite-fallback")).toBeInTheDocument()

    act(() => getPetSkinRuntime().retryAsset("sprite-v2:momo"))
    await act(async () => Promise.resolve())

    expect(loadSpriteSkinAsset).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("pet-sprite-v2")).toBeInTheDocument()
  })
})
