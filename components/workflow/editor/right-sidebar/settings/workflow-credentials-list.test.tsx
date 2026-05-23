/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { WorkflowCredentialsList } from "./workflow-credentials-list"

const messages = {
  workflowEditor: {
    settings: {
      credentials: {
        addButton: "Add credential ref",
        idPlaceholder: "keyring:ns:key",
        namePlaceholder: "Display name",
        kindPlaceholder: "kind",
        removeAria: "Remove credential ref",
        refOnlyNote: "Refs only — never values.",
        empty: "No credential references yet.",
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("WorkflowCredentialsList", () => {
  it("shows the ref-only note and empty state", () => {
    wrap(<WorkflowCredentialsList value={{}} onChange={jest.fn()} />)
    expect(screen.getByText(/Refs only/)).toBeInTheDocument()
    expect(screen.getByText("No credential references yet.")).toBeInTheDocument()
  })

  it("edits a ref's id and re-keys the map", () => {
    const onChange = jest.fn()
    wrap(
      <WorkflowCredentialsList
        value={{ "keyring:tg:bot": { id: "keyring:tg:bot", name: "Telegram" } }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByTestId("wf-cred-name-0"), { target: { value: "TG bot" } })
    expect(onChange).toHaveBeenCalledWith({
      "keyring:tg:bot": { id: "keyring:tg:bot", name: "TG bot", kind: undefined },
    })
  })

  it("removes a ref", () => {
    const onChange = jest.fn()
    wrap(<WorkflowCredentialsList value={{ a: { id: "a", name: "A" } }} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("wf-cred-remove-0"))
    expect(onChange).toHaveBeenCalledWith({})
  })

  it("never renders a secret-value input", () => {
    wrap(<WorkflowCredentialsList value={{ a: { id: "a", name: "A" } }} onChange={jest.fn()} />)
    // Only id / name / kind fields exist — no password/value field.
    expect(screen.queryByPlaceholderText(/secret|value|password/i)).toBeNull()
  })
})
