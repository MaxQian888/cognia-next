import { act, render, screen } from "@testing-library/react"
import type { PetSkinRenderProps } from "@/types/pet"

const useActiveSpritePack = jest.fn()
jest.mock("@/hooks/pet/use-active-sprite-pack", () => ({
  useActiveSpritePack: () => useActiveSpritePack(),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ settings: { petSettings: { activeSpritePackId: "momo" } } }),
}))
jest.mock("./svg-skin", () => ({
  svgSkin: { id: "svg", render: () => <div data-testid="sprite-fallback" /> },
}))

import { resolveSpriteAnimation, spriteV2Skin } from "./sprite-v2-skin"

const props: PetSkinRenderProps = {
  bones: {} as never,
  stage: "adult",
  state: "idle",
  oneShot: null,
  reducedMotion: false,
  size: 104,
}

describe("spriteV2Skin", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useActiveSpritePack.mockReturnValue({
      packId: "momo",
      row: { id: "momo", spritesheet: new Blob(["atlas"], { type: "image/webp" }) },
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
    jest.clearAllTimers()
    jest.useRealTimers()
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

  it("honors reduced motion and releases the object URL", async () => {
    const { unmount } = render(<>{spriteV2Skin.render({ ...props, reducedMotion: true })}</>)
    await act(async () => Promise.resolve())
    const sprite = screen.getByTestId("pet-sprite-v2")

    act(() => jest.advanceTimersByTime(1_000))
    expect(sprite.style.backgroundPosition).toBe("0px 0px")

    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sprite")
  })

  it("keeps the current frame while paused", async () => {
    render(<>{spriteV2Skin.render({ ...props, paused: true })}</>)
    await act(async () => Promise.resolve())
    const sprite = screen.getByTestId("pet-sprite-v2")
    act(() => jest.advanceTimersByTime(1_000))
    expect(sprite.style.backgroundPosition).toBe("0px 0px")
  })

  it("uses the SVG fallback when the configured pack is missing", () => {
    useActiveSpritePack.mockReturnValue({ packId: "missing", row: undefined })
    render(<>{spriteV2Skin.render(props)}</>)
    expect(screen.getByTestId("sprite-fallback")).toBeInTheDocument()
  })
})
