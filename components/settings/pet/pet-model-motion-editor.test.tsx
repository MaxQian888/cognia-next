import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

import { PetModelMotionEditor, type PetModelMotionEditorProps } from "./pet-model-motion-editor"

function setup(partial: Partial<PetModelMotionEditorProps> = {}) {
  const props: PetModelMotionEditorProps = {
    motionGroups: ["Idle", "Tap", "Special"],
    expressionIds: ["happy", "sad"],
    motionGroupCounts: { Idle: 3, Tap: 1, Special: 2 },
    value: {},
    onChange: jest.fn(),
    onTest: jest.fn(),
    ...partial,
  }
  const view = render(<PetModelMotionEditor {...props} />)
  return { ...view, props }
}

const groupSelect = (key: string) =>
  screen.getByTestId(`pet-mapping-group-${key}`) as HTMLSelectElement
const indexSelect = (key: string) =>
  screen.getByTestId(`pet-mapping-index-${key}`) as HTMLSelectElement
const expressionSelect = (key: string) =>
  screen.getByTestId(`pet-mapping-expression-${key}`) as HTMLSelectElement

describe("PetModelMotionEditor", () => {
  it("renders one row per state + namespaced one-shot (24 total)", () => {
    setup()
    expect(screen.getAllByTestId(/pet-mapping-row-/)).toHaveLength(24)
    expect(screen.getByTestId("pet-mapping-row-unwell")).toBeInTheDocument()
    expect(screen.getByTestId("pet-mapping-row-happy")).toBeInTheDocument()
    expect(screen.getByTestId("pet-mapping-row-shot:happy")).toBeInTheDocument()
    expect(screen.getByTestId("pet-mapping-row-shot:love")).toBeInTheDocument()
  })

  it("picking a real group emits an entry with that group (index random)", () => {
    const { props } = setup()
    fireEvent.change(groupSelect("happy"), { target: { value: "Special" } })
    expect(props.onChange).toHaveBeenCalledWith({ happy: { motionGroup: "Special" } })
  })

  it("picking 'engine default' emits an empty entry, keeping a chosen expression", () => {
    const { props } = setup({ value: { happy: { motionGroup: "Tap", expressionId: "sad" } } })
    fireEvent.change(groupSelect("happy"), { target: { value: "__engine" } })
    expect(props.onChange).toHaveBeenCalledWith({ happy: { expressionId: "sad" } })
  })

  it("picking 'default' removes the key from the overrides", () => {
    const { props } = setup({ value: { happy: { motionGroup: "Tap" }, idle: {} } })
    fireEvent.change(groupSelect("happy"), { target: { value: "__default" } })
    expect(props.onChange).toHaveBeenCalledWith({ idle: {} })
  })

  it("the index select sizes from the group's motion count and emits fixed indices", () => {
    const { props } = setup({ value: { idle: { motionGroup: "Idle" } } })
    const idx = indexSelect("idle")
    expect(idx.disabled).toBe(false)
    // random + 3 indices (Idle has count 3)
    expect(idx.querySelectorAll("option")).toHaveLength(4)
    fireEvent.change(idx, { target: { value: "2" } })
    expect(props.onChange).toHaveBeenCalledWith({ idle: { motionGroup: "Idle", motionIndex: 2 } })
  })

  it("selecting random clears the fixed index", () => {
    const { props } = setup({ value: { idle: { motionGroup: "Idle", motionIndex: 1 } } })
    fireEvent.change(indexSelect("idle"), { target: { value: "__random" } })
    expect(props.onChange).toHaveBeenCalledWith({ idle: { motionGroup: "Idle" } })
  })

  it("index select is disabled without a real group", () => {
    setup({ value: { idle: {} } })
    expect(indexSelect("idle").disabled).toBe(true)
    expect(indexSelect("happy").disabled).toBe(true)
  })

  it("expression select emits and clears the expression", () => {
    const { props } = setup({ value: { sad: { motionGroup: "Idle" } } })
    fireEvent.change(expressionSelect("sad"), { target: { value: "sad" } })
    expect(props.onChange).toHaveBeenCalledWith({
      sad: { motionGroup: "Idle", expressionId: "sad" },
    })
    fireEvent.change(expressionSelect("sad"), { target: { value: "__none" } })
    expect(props.onChange).toHaveBeenLastCalledWith({ sad: { motionGroup: "Idle" } })
  })

  it("expression select is disabled for convention-default rows", () => {
    setup()
    expect(expressionSelect("idle").disabled).toBe(true)
  })

  it("test buttons report the row", () => {
    const { props } = setup()
    fireEvent.click(screen.getByTestId("pet-mapping-test-shot:wave"))
    expect(props.onTest).toHaveBeenCalledWith(
      expect.objectContaining({ key: "shot:wave", kind: "oneShot", id: "wave" })
    )
  })

  it("reset-all emits an empty table", () => {
    const { props } = setup({ value: { happy: { motionGroup: "Tap" } } })
    fireEvent.click(screen.getByRole("button", { name: /resetMappings/ }))
    expect(props.onChange).toHaveBeenCalledWith({})
  })
})
