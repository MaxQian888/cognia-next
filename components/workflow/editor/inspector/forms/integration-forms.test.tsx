/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import {
  SkillInvokeConfig,
  TwinRagConfig,
  SkillUpsertConfig,
  TwinIngestConfig,
  MemoryRecallConfig,
  MemoryStoreConfig,
  McpInvokeToolConfig,
  PluginInvokeConfig,
} from "./integration-forms"

// ExpressionField mounts a CodeMirror editor; stub it to a plain input so the
// forms render in jsdom and param edits are assertable.
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

/** The shared `Field` primitive stamps `data-field`; query by that, not text. */
function fieldInput(container: HTMLElement, name: string): HTMLElement {
  const field = container.querySelector(`[data-field="${name}"]`)
  if (!field) throw new Error(`no field named ${name}`)
  const control = field.querySelector("input, textarea")
  if (!control) throw new Error(`no control inside field ${name}`)
  return control as HTMLElement
}

describe("integration-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        SkillInvokeConfig,
        TwinRagConfig,
        SkillUpsertConfig,
        TwinIngestConfig,
        MemoryRecallConfig,
        MemoryStoreConfig,
        McpInvokeToolConfig,
        PluginInvokeConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})

/**
 * `action.memory.store` / `action.memory.recall` each honour params that had
 * no field at all — the whole procedural-memory path (`type` + `provenance` +
 * `key`) and recall's `relevanceFloor` / `types` filters were reachable only
 * by hand-editing JSON, which the inspector does not expose once a kind has a
 * dedicated form.
 */
describe("MemoryStoreConfig — memory type, provenance and stable key", () => {
  it("writes the three params the executor reads", () => {
    const onChange = jest.fn()
    const { container } = render(<MemoryStoreConfig params={{ text: "x" }} onChange={onChange} />)

    fireEvent.change(fieldInput(container, "key"), { target: { value: "tone-rule" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ key: "tone-rule" }))
  })

  it("defaults to the values runMemoryStore assumes", () => {
    const { container } = render(<MemoryStoreConfig params={{}} onChange={jest.fn()} />)
    // semantic + system are the executor's fallbacks; showing anything else
    // would misreport what an unset node actually does.
    const type = container.querySelector('[data-field="type"]') as HTMLElement
    const provenance = container.querySelector('[data-field="provenance"]') as HTMLElement
    expect(within(type).getByRole("combobox")).toHaveTextContent("Semantic (fact)")
    expect(within(provenance).getByRole("combobox")).toHaveTextContent("System (automated)")
  })

  it("warns when a procedural rule is left on system provenance", () => {
    const { rerender } = render(
      <MemoryStoreConfig params={{ type: "procedural" }} onChange={jest.fn()} />
    )
    expect(screen.getByTestId("ms-procedural-warning")).toBeInTheDocument()

    rerender(
      <MemoryStoreConfig
        params={{ type: "procedural", provenance: "explicit" }}
        onChange={jest.fn()}
      />
    )
    expect(screen.queryByTestId("ms-procedural-warning")).not.toBeInTheDocument()
  })
})

describe("MemoryRecallConfig — relevance floor and type filter", () => {
  it("shows the floor the executor actually applies when unset", () => {
    const { container } = render(
      <MemoryRecallConfig params={{ query: "q" }} onChange={jest.fn()} />
    )
    expect(fieldInput(container, "relevanceFloor")).toHaveValue(0.1)
  })

  it("clamps the floor into the 0–1 range the schema allows", () => {
    const onChange = jest.fn()
    const { container } = render(<MemoryRecallConfig params={{ query: "q" }} onChange={onChange} />)
    fireEvent.change(fieldInput(container, "relevanceFloor"), { target: { value: "5" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ relevanceFloor: 1 }))
  })

  it("toggles memory types and drops the key when nothing is selected", () => {
    const onChange = jest.fn()
    const { rerender } = render(<MemoryRecallConfig params={{ query: "q" }} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("mr-type-procedural"))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: ["procedural"] }))

    rerender(
      <MemoryRecallConfig params={{ query: "q", types: ["procedural"] }} onChange={onChange} />
    )
    fireEvent.click(screen.getByTestId("mr-type-procedural"))
    // Empty list and absent both mean "every type" — store the simpler one.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: undefined }))
  })
})
