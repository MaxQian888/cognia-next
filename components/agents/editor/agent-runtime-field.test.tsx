/** @jest-environment jsdom */

// An agent's default runtime as a form field (ADR-0220). The composer's own
// runtime chip is stubbed so the field's binding logic is what is under test.

import { fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"

import type { CharacterRuntimeBinding } from "@cognia/agent-config-types"
import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"

let mockRuntimes: AgentRuntimeDescriptor[] = []
const mockCatalogArgs: unknown[][] = []
jest.mock("@/hooks/agent/use-agent-runtime-catalog", () => ({
  useAgentRuntimeCatalog: (...args: unknown[]) => {
    mockCatalogArgs.push(args)
    return { runtimes: mockRuntimes }
  },
}))

type SelectorProps = ComponentProps<
  typeof import("@/components/agent/mode/runtime-selector").AgentRuntimeSelector
>
let mockSelectorProps: SelectorProps | undefined
let mockPick: AgentRuntimeDescriptor | undefined
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: (props: SelectorProps) => {
    mockSelectorProps = props
    return (
      <div>
        <button
          type="button"
          onClick={() => mockPick && props.controlled?.onSelectRuntime(mockPick)}
        >
          pick-row
        </button>
        <button type="button" onClick={() => props.controlled?.defaultOption?.onSelect()}>
          pick-default
        </button>
      </div>
    )
  },
}))

import { AgentRuntimeField } from "./agent-runtime-field"

function row(
  over: Partial<AgentRuntimeDescriptor> & Pick<AgentRuntimeDescriptor, "ref" | "key">
): AgentRuntimeDescriptor {
  return { group: over.ref.kind, ...over } as AgentRuntimeDescriptor
}

const BUILTIN = row({ ref: { kind: "builtin" }, key: "builtin" })
const CODEX = row({
  ref: { kind: "external", agentId: "codex" },
  key: "external:codex",
  name: "Codex",
})
const HOST = row({
  ref: { kind: "host", configId: "cfg-1", revision: "r1", lifecycleGeneration: 1, name: "Box" },
  key: "host:cfg-1",
  name: "Box",
})

function renderField(value: CharacterRuntimeBinding | undefined, disabled?: boolean) {
  const onChange = jest.fn<void, [CharacterRuntimeBinding | undefined]>()
  render(<AgentRuntimeField value={value} onChange={onChange} disabled={disabled} />)
  return onChange
}

beforeEach(() => {
  mockRuntimes = [BUILTIN, CODEX, HOST]
  mockCatalogArgs.length = 0
  mockSelectorProps = undefined
  mockPick = undefined
})

describe("AgentRuntimeField", () => {
  it("labels the field and reads the catalog without a provider or session", () => {
    renderField(undefined)
    expect(screen.getByText("Default runtime")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Where a new conversation with this agent runs. You can still switch it in the composer."
      )
    ).toBeInTheDocument()
    expect(mockCatalogArgs[0]).toEqual([undefined, undefined])
  })

  it("renders the selector as a controlled field with the app default active when unset", () => {
    renderField(undefined)
    expect(mockSelectorProps?.variant).toBe("field")
    expect(mockSelectorProps?.controlled?.selectedKey).toBeUndefined()
    expect(mockSelectorProps?.controlled?.defaultOption).toMatchObject({
      label: "Follow the app default",
      description: "Whatever runtime new chats use",
      active: true,
    })
    expect(mockSelectorProps?.controlled?.unavailableLabel).toBeUndefined()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("passes disabled through", () => {
    renderField(undefined, true)
    expect(mockSelectorProps?.disabled).toBe(true)
  })

  it("marks the built-in lane without a warning or an unavailable label", () => {
    mockRuntimes = []
    renderField({ kind: "builtin" })
    expect(mockSelectorProps?.controlled?.selectedKey).toBe("builtin")
    expect(mockSelectorProps?.controlled?.defaultOption?.active).toBe(false)
    expect(mockSelectorProps?.controlled?.unavailableLabel).toBeUndefined()
    // The built-in lane always resolves, even with no catalog row.
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("marks a stored external agent that is available", () => {
    renderField({ kind: "external", agentId: "codex", name: "Codex" })
    expect(mockSelectorProps?.controlled?.selectedKey).toBe("external:codex")
    expect(mockSelectorProps?.controlled?.unavailableLabel).toBe("Codex (unavailable)")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("flags a stored external agent missing on this device, falling back to its id", () => {
    renderField({ kind: "external", agentId: "gone" })
    expect(mockSelectorProps?.controlled?.selectedKey).toBe("external:gone")
    expect(mockSelectorProps?.controlled?.unavailableLabel).toBe("gone (unavailable)")
    expect(screen.getByRole("status")).toHaveTextContent(
      "This runtime isn't available on this device. New conversations will use the app default until you pick another."
    )
  })

  it("flags a stored host configuration that is gone, naming it by its cached label or id", () => {
    renderField({ kind: "host", configId: "cfg-old", name: "Old box" })
    expect(mockSelectorProps?.controlled?.selectedKey).toBe("host:cfg-old")
    expect(mockSelectorProps?.controlled?.unavailableLabel).toBe("Old box (unavailable)")
    expect(screen.getByRole("status")).toHaveTextContent("isn't available on this device")
  })

  it("names an unlabelled host configuration by its id", () => {
    renderField({ kind: "host", configId: "cfg-old" })
    expect(mockSelectorProps?.controlled?.unavailableLabel).toBe("cfg-old (unavailable)")
  })

  it("shows the row's warning when the stored runtime is available but degraded", () => {
    mockRuntimes = [BUILTIN, { ...CODEX, warning: "Codex is signed out" } as AgentRuntimeDescriptor]
    renderField({ kind: "external", agentId: "codex" })
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("Codex is signed out")
    expect(status).not.toHaveClass("text-destructive")
  })

  it("stores a picked external row with its name", () => {
    mockPick = CODEX
    const onChange = renderField(undefined)
    fireEvent.click(screen.getByText("pick-row"))
    expect(onChange).toHaveBeenCalledWith({ kind: "external", agentId: "codex", name: "Codex" })
  })

  it("stores a picked host row without its admission stamp", () => {
    mockPick = HOST
    const onChange = renderField(undefined)
    fireEvent.click(screen.getByText("pick-row"))
    expect(onChange).toHaveBeenCalledWith({ kind: "host", configId: "cfg-1", name: "Box" })
  })

  it("stores the built-in row as a builtin binding", () => {
    mockPick = BUILTIN
    const onChange = renderField({ kind: "external", agentId: "codex" })
    fireEvent.click(screen.getByText("pick-row"))
    expect(onChange).toHaveBeenCalledWith({ kind: "builtin" })
  })

  it("clears the binding when the app default is picked", () => {
    const onChange = renderField({ kind: "external", agentId: "codex" })
    fireEvent.click(screen.getByText("pick-default"))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
