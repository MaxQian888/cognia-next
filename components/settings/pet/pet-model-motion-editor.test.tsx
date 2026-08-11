import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
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
  return { ...render(<PetModelMotionEditor {...props} />), props }
}

async function choose(testId: string, option: string | RegExp) {
  const user = userEvent.setup()
  await user.click(screen.getByTestId(testId))
  await user.click(screen.getByRole("option", { name: option }))
}

describe("PetModelMotionEditor", () => {
  it("renders one responsive row per state and namespaced one-shot", () => {
    setup()
    expect(screen.getAllByTestId(/pet-mapping-row-/)).toHaveLength(24)
    expect(screen.getByTestId("pet-mapping-row-unwell")).toBeInTheDocument()
    expect(screen.getByTestId("pet-mapping-row-shot:love")).toBeInTheDocument()
  })

  it("picks real, engine-default, and convention-default motion groups", async () => {
    const real = setup()
    await choose("pet-mapping-group-happy", "Special")
    expect(real.props.onChange).toHaveBeenCalledWith({ happy: { motionGroup: "Special" } })
    real.unmount()

    const engine = setup({ value: { happy: { motionGroup: "Tap", expressionId: "sad" } } })
    await choose("pet-mapping-group-happy", /optionEngine/)
    expect(engine.props.onChange).toHaveBeenCalledWith({ happy: { expressionId: "sad" } })
    engine.unmount()

    const convention = setup({ value: { happy: { motionGroup: "Tap" }, idle: {} } })
    await choose("pet-mapping-group-happy", /optionDefault/)
    expect(convention.props.onChange).toHaveBeenCalledWith({ idle: {} })
  })

  it("sizes indices from the selected group and emits fixed or random values", async () => {
    const fixed = setup({ value: { idle: { motionGroup: "Idle" } } })
    await userEvent.setup().click(screen.getByTestId("pet-mapping-index-idle"))
    expect(screen.getAllByRole("option")).toHaveLength(4)
    await userEvent.setup().click(screen.getByRole("option", { name: "2" }))
    expect(fixed.props.onChange).toHaveBeenCalledWith({
      idle: { motionGroup: "Idle", motionIndex: 2 },
    })
    fixed.unmount()

    const random = setup({ value: { idle: { motionGroup: "Idle", motionIndex: 1 } } })
    await choose("pet-mapping-index-idle", /indexRandom/)
    expect(random.props.onChange).toHaveBeenCalledWith({ idle: { motionGroup: "Idle" } })
  })

  it("disables index and expression selectors until their override exists", () => {
    setup({ value: { idle: {} } })
    expect(screen.getByTestId("pet-mapping-index-idle")).toBeDisabled()
    expect(screen.getByTestId("pet-mapping-index-happy")).toBeDisabled()
    expect(screen.getByTestId("pet-mapping-expression-happy")).toBeDisabled()
  })

  it("sets and clears expressions", async () => {
    const set = setup({ value: { sad: { motionGroup: "Idle" } } })
    await choose("pet-mapping-expression-sad", "sad")
    expect(set.props.onChange).toHaveBeenCalledWith({
      sad: { motionGroup: "Idle", expressionId: "sad" },
    })
    set.unmount()

    const clear = setup({ value: { sad: { motionGroup: "Idle", expressionId: "sad" } } })
    await choose("pet-mapping-expression-sad", /optionNoExpression/)
    expect(clear.props.onChange).toHaveBeenCalledWith({ sad: { motionGroup: "Idle" } })
  })

  it("tests a mapping and resets the override table", async () => {
    const { props } = setup({ value: { happy: { motionGroup: "Tap" } } })
    const user = userEvent.setup()
    await user.click(screen.getByTestId("pet-mapping-test-shot:wave"))
    expect(props.onTest).toHaveBeenCalledWith(
      expect.objectContaining({ key: "shot:wave", kind: "oneShot", id: "wave" })
    )
    await user.click(screen.getByRole("button", { name: /resetMappings/ }))
    expect(props.onChange).toHaveBeenCalledWith({})
  })
})
