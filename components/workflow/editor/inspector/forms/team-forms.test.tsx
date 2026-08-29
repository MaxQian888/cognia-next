/**
 * @jest-environment jsdom
 */
import { fireEvent, render, within } from "@testing-library/react"
import {
  CharacterSendConfig,
  TeamRunConfig,
  TeamReconcileConfig,
  TeamComposeConfig,
  TeamStatusConfig,
  TeamDelegateConfig,
  TeamMessageConfig,
  AgentTurnConfig,
  CharacterCreateConfig,
  CharacterUpdateConfig,
  TeamCreateConfig,
  TeamUpdateConfig,
  TeamTaskDispatchConfig,
  PetInteractConfig,
} from "./team-forms"

// ExpressionField mounts a CodeMirror editor; stub it to a plain input.
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

/** The shared `Field` primitive stamps `data-field`; query by that, not text. */
function fieldControl(container: HTMLElement, name: string): HTMLElement {
  const field = container.querySelector(`[data-field="${name}"]`)
  if (!field) throw new Error(`no field named ${name}`)
  const control = field.querySelector("input, textarea, [role='combobox']")
  if (!control) throw new Error(`no control inside field ${name}`)
  return control as HTMLElement
}

describe("team-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        CharacterSendConfig,
        TeamRunConfig,
        TeamReconcileConfig,
        TeamComposeConfig,
        TeamStatusConfig,
        TeamDelegateConfig,
        TeamMessageConfig,
        AgentTurnConfig,
        CharacterCreateConfig,
        CharacterUpdateConfig,
        TeamCreateConfig,
        TeamUpdateConfig,
        TeamTaskDispatchConfig,
        PetInteractConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})

/**
 * `action.agent.turn` forwards `temperature` and `timeoutMs` to every turn it
 * runs, and neither had a field — a kind with a dedicated form gets no
 * raw-JSON fallback, so they were unreachable from the editor.
 */
describe("AgentTurnConfig — sampling and timeout", () => {
  it("leaves temperature empty when unset so it does not claim a value it is not sending", () => {
    const { container } = render(<AgentTurnConfig params={{ prompt: "hi" }} onChange={jest.fn()} />)
    expect(fieldControl(container, "temperature")).toHaveValue(null)
  })

  it("clamps temperature to the schema's 0..2 window", () => {
    const onChange = jest.fn()
    const { container } = render(<AgentTurnConfig params={{ prompt: "hi" }} onChange={onChange} />)
    fireEvent.change(fieldControl(container, "temperature"), { target: { value: "9" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ temperature: 2 }))
  })

  it("clears temperature back to the provider default on an empty input", () => {
    const onChange = jest.fn()
    const { container } = render(
      <AgentTurnConfig params={{ prompt: "hi", temperature: 0.5 }} onChange={onChange} />
    )
    fireEvent.change(fieldControl(container, "temperature"), { target: { value: "" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ temperature: undefined }))
  })

  it("shows the executor's 10-minute timeout fallback rather than a blank box", () => {
    const { container } = render(<AgentTurnConfig params={{ prompt: "hi" }} onChange={jest.fn()} />)
    // DurationField picks the largest exact unit: 600000ms renders as 10 min.
    expect(fieldControl(container, "timeoutMs")).toHaveValue(10)
  })
})

/**
 * `action.team.task.dispatch` is what `synthesizeTeamWorkflow` stamps out when
 * an agent team becomes a workflow. Four of the params it writes — access,
 * task kind, repository and file ownership — were in neither the zod schema
 * nor the form, so opening a synthesized workflow hid the settings that decide
 * whether a teammate may write at all.
 */
describe("TeamTaskDispatchConfig — the synthesized task settings", () => {
  it("edits the preferred teammate and the dependency list", () => {
    const onChange = jest.fn()
    const { container } = render(<TeamTaskDispatchConfig params={{}} onChange={onChange} />)

    fireEvent.change(fieldControl(container, "assignedTo"), { target: { value: "mate-1" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ assignedTo: "mate-1" }))

    fireEvent.change(fieldControl(container, "dependencies"), { target: { value: "a, b ," } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ dependencies: ["a", "b"] }))
  })

  it("drops an emptied list instead of storing []", () => {
    const onChange = jest.fn()
    const { container } = render(
      <TeamTaskDispatchConfig params={{ fileOwnership: ["src/a.ts"] }} onChange={onChange} />
    )
    fireEvent.change(fieldControl(container, "fileOwnership"), { target: { value: "  " } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fileOwnership: undefined }))
  })

  it("surfaces the access mode and task kind a synthesized node carries", () => {
    const { container } = render(
      <TeamTaskDispatchConfig params={{ access: "read", taskKind: "ui" }} onChange={jest.fn()} />
    )
    const access = container.querySelector('[data-field="access"]') as HTMLElement
    const kind = container.querySelector('[data-field="taskKind"]') as HTMLElement
    expect(within(access).getByRole("combobox")).toHaveTextContent("Read only")
    expect(within(kind).getByRole("combobox")).toHaveTextContent("UI")
  })

  it("defaults to the write/code pair the synthesizer treats as normal", () => {
    const { container } = render(<TeamTaskDispatchConfig params={{}} onChange={jest.fn()} />)
    const access = container.querySelector('[data-field="access"]') as HTMLElement
    expect(within(access).getByRole("combobox")).toHaveTextContent("Read and write")
  })
})

/**
 * `action.character.send` persists the message as `user` or `assistant`, and
 * the choice is load-bearing: a `user` message only draws a reply while that
 * character's chat is open (the executor reports `deliveryDeferred`), while
 * `assistant` posts as the character itself. Neither the schema nor the form
 * offered it, so only the deferred half was reachable.
 */
describe("CharacterSendConfig — message attribution", () => {
  it("defaults to the executor's own fallback and explains the deferral", () => {
    const { container } = render(<CharacterSendConfig params={{}} onChange={jest.fn()} />)
    const role = container.querySelector('[data-field="role"]') as HTMLElement
    expect(within(role).getByRole("combobox")).toHaveTextContent("The user")
    expect(container.querySelector('[data-testid="cs-deferred-note"]')).not.toBeNull()
  })

  it("drops the deferral note once the character itself is speaking", () => {
    const { container } = render(
      <CharacterSendConfig params={{ role: "assistant" }} onChange={jest.fn()} />
    )
    expect(container.querySelector('[data-testid="cs-deferred-note"]')).toBeNull()
  })
})
