/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const usePetBubbles = jest.fn()
const usePetSpeak = jest.fn()
const usePetProactive = jest.fn()
const usePetInsight = jest.fn()
const usePetScheduledReminder = jest.fn()
const useActiveLive2dModel = jest.fn()
const useActiveSpritePack = jest.fn()
const usePetMock = jest.fn()

jest.mock("@/hooks/pet/use-pet", () => ({ usePet: (id: unknown) => usePetMock(id) }))
jest.mock("@/hooks/pet/use-pet-bubbles", () => ({
  usePetBubbles: (...a: unknown[]) => usePetBubbles(...a),
}))
jest.mock("@/hooks/pet/use-pet-speak", () => ({
  usePetSpeak: (...a: unknown[]) => usePetSpeak(...a),
}))
jest.mock("@/hooks/pet/use-pet-proactive", () => ({
  usePetProactive: (...a: unknown[]) => usePetProactive(...a),
}))
jest.mock("@/hooks/pet/use-pet-insight", () => ({
  usePetInsight: (...a: unknown[]) => usePetInsight(...a),
}))
jest.mock("@/hooks/pet/use-pet-scheduled-reminder", () => ({
  usePetScheduledReminder: (...a: unknown[]) => usePetScheduledReminder(...a),
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: (...a: unknown[]) => useActiveLive2dModel(...a),
}))
jest.mock("@/hooks/pet/use-active-sprite-pack", () => ({
  useActiveSpritePack: (...a: unknown[]) => useActiveSpritePack(...a),
}))

import { PetMainRuntime } from "./pet-main-runtime"
import { usePetStore } from "@/stores/pet/pet-store"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { DEFAULT_PET_SETTINGS, type PetProfile, type PetSettings } from "@/types/pet"

const profile: PetProfile = {
  ...createDefaultProfile("acct-1", 0),
  soul: { name: "Boba", personality: "x", hatchDate: "" },
  stage: "baby",
}
const view = computePetView(profile, null, 0)

beforeEach(() => {
  for (const m of [
    usePetBubbles,
    usePetSpeak,
    usePetProactive,
    usePetInsight,
    usePetScheduledReminder,
  ]) {
    m.mockClear()
  }
  usePetMock.mockReset().mockReturnValue({ profile, view, binding: null })
  useActiveLive2dModel
    .mockReset()
    .mockReturnValue({ modelId: undefined, row: undefined, coreReady: false })
  useActiveSpritePack.mockReset().mockReturnValue({ row: undefined })
  usePetStore.setState({ appearanceSelection: null })
})

function renderRuntime(settings: Partial<PetSettings> = {}, activeCharacterId?: string) {
  return render(
    <PetMainRuntime
      settings={{ ...DEFAULT_PET_SETTINGS, ...settings }}
      activeCharacterId={activeCharacterId}
    />
  )
}

describe("PetMainRuntime", () => {
  it("renders nothing", () => {
    const { container } = renderRuntime()
    expect(container).toBeEmptyDOMElement()
  })

  it("runs every speech producer for the active character", () => {
    renderRuntime({}, "char-9")
    expect(usePetMock).toHaveBeenCalledWith("char-9")
    expect(usePetBubbles).toHaveBeenCalledWith(true, view.effectiveStats.snark)
    expect(usePetSpeak).toHaveBeenCalledWith({
      profile,
      view,
      enabled: true,
      activeCharacterId: "char-9",
    })
    expect(usePetProactive).toHaveBeenCalledWith({ profile, view, enabled: true })
    expect(usePetInsight).toHaveBeenCalledWith(true)
    expect(usePetScheduledReminder).toHaveBeenCalledWith(true)
  })

  it("mutes chatter but keeps real reminders when bubbles are muted", () => {
    renderRuntime({ mutedBubbles: true })
    expect(usePetBubbles).toHaveBeenCalledWith(false, expect.any(Number))
    expect(usePetSpeak).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    expect(usePetProactive).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    expect(usePetInsight).toHaveBeenCalledWith(false)
    expect(usePetScheduledReminder).toHaveBeenCalledWith(true)
  })

  it("publishes the SVG appearance when no imported skin can render", () => {
    renderRuntime()
    expect(usePetStore.getState().appearanceSelection).toEqual({ skinId: "svg" })
  })

  it("publishes a ready Live2D model as the appearance the overlay mirrors", () => {
    useActiveLive2dModel.mockReturnValue({
      modelId: "hiyori",
      row: { compatibility: { status: "ready" } },
      coreReady: true,
    })
    renderRuntime({ skinId: "live2d", activeLive2dModelId: "hiyori" })
    expect(usePetStore.getState().appearanceSelection).toEqual({
      skinId: "live2d",
      modelId: "hiyori",
    })
  })

  it("falls back to SVG for an invalid Live2D model", () => {
    useActiveLive2dModel.mockReturnValue({
      modelId: "broken",
      row: { compatibility: { status: "invalid" } },
      coreReady: true,
    })
    renderRuntime({ skinId: "live2d", activeLive2dModelId: "broken" })
    expect(usePetStore.getState().appearanceSelection).toEqual({ skinId: "svg" })
  })

  it("publishes an active sprite pack", () => {
    useActiveSpritePack.mockReturnValue({ row: { id: "pack-1" } })
    renderRuntime({ skinId: "sprite-v2", activeSpritePackId: "pack-1" })
    expect(usePetStore.getState().appearanceSelection).toEqual({
      skinId: "sprite-v2",
      packId: "pack-1",
    })
  })

  it("republishes only when the resolved appearance changes", () => {
    const spy = jest.spyOn(usePetStore.getState(), "setAppearanceSelection")
    const { rerender } = renderRuntime()
    const calls = spy.mock.calls.length
    rerender(<PetMainRuntime settings={{ ...DEFAULT_PET_SETTINGS }} />)
    expect(spy.mock.calls.length).toBe(calls)
    spy.mockRestore()
  })
})
