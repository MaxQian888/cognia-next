/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { UseAdapterCredentialsResult } from "@/hooks/connectors/use-adapter-credentials"

import { AdapterForm, type JsonSchema } from "./adapter-form"

/**
 * The keyring controller as the form sees it. Stubbed rather than driven
 * through Dexie + the keyring commands: this suite is about the generator,
 * and `use-adapter-credentials` has its own.
 */
function fakeCredentials(
  overrides: Partial<UseAdapterCredentialsResult> = {}
): UseAdapterCredentialsResult {
  return {
    value: () => "",
    status: () => "new",
    set: jest.fn(),
    dirty: false,
    intent: () => "unchanged",
    missingRequired: () => [],
    persist: jest.fn(async () => undefined),
    derivedPresence: () => undefined,
    loading: false,
    retry: jest.fn(),
    refused: false,
    ...overrides,
  } as unknown as UseAdapterCredentialsResult
}

// ---------------------------------------------------------------------------
// Mock schema fixtures
// ---------------------------------------------------------------------------

const STRING_SCHEMA: JsonSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", title: "Name" },
    notes: { type: "string", title: "Notes" },
  },
}

const BOOL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", title: "Enabled" },
  },
}

const ENUM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    transport: {
      type: "string",
      title: "Transport",
      enum: ["longpoll", "webhook"],
    },
  },
}

const MIXED_SCHEMA: JsonSchema = {
  type: "object",
  required: ["token"],
  properties: {
    token: { type: "string", title: "Bot Token" },
    webhookSecret: { type: "string", title: "Webhook Secret" },
    enabled: { type: "boolean", title: "Enabled" },
    transport: { type: "string", title: "Transport", enum: ["longpoll", "webhook"] },
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdapterForm — string fields", () => {
  it("renders a label and input for each string property", () => {
    render(<AdapterForm schema={STRING_SCHEMA} onSubmit={jest.fn()} />)
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/notes/i)).toBeInTheDocument()
  })

  it("shows required asterisk for required fields", () => {
    render(<AdapterForm schema={STRING_SCHEMA} onSubmit={jest.fn()} />)
    // The required * is inside the label for 'name'
    const nameLabel = screen.getByText("Name", { selector: "label" })
    expect(nameLabel.innerHTML).toContain("*")
  })

  it("renders secret fields masked, through the shared credential input", () => {
    render(
      <AdapterForm
        schema={MIXED_SCHEMA}
        secretFields={["token"]}
        credentials={fakeCredentials()}
        onSubmit={jest.fn()}
      />
    )
    const tokenInput = screen.getByLabelText(/bot token/i) as HTMLInputElement
    expect(tokenInput.type).toBe("password")
  })

  /**
   * The separation is the point: a secret typed here goes to the keyring
   * controller, never into `values`, which is what gets written to
   * `AdapterInstanceRow.settings` — a plain Dexie row that backups copy.
   */
  it("routes a secret to the credential controller and keeps it out of values", async () => {
    const handleSubmit = jest.fn()
    const credentials = fakeCredentials()
    render(
      <AdapterForm
        schema={MIXED_SCHEMA}
        secretFields={["token"]}
        credentials={credentials}
        onSubmit={handleSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "my-secret-token" },
    })
    expect(credentials.set).toHaveBeenCalledWith("token", "my-secret-token")

    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(handleSubmit).toHaveBeenCalled())
    expect(handleSubmit.mock.calls[0][0]).not.toHaveProperty("token")
    expect(handleSubmit.mock.calls[0][0]).toEqual(expect.objectContaining({ enabled: false }))
  })

  // The controller's own state drives the field, so a stored value shows up
  // prefilled on reopen exactly as it does on a built-in platform form.
  it("shows the value the controller already read back", () => {
    render(
      <AdapterForm
        schema={MIXED_SCHEMA}
        secretFields={["token"]}
        credentials={fakeCredentials({ value: () => "stored-token", status: () => "loaded" })}
        onSubmit={jest.fn()}
      />
    )
    expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe("stored-token")
  })
})

describe("AdapterForm — boolean fields", () => {
  it("renders a Switch for boolean properties", () => {
    render(<AdapterForm schema={BOOL_SCHEMA} onSubmit={jest.fn()} />)
    expect(screen.getByRole("switch")).toBeInTheDocument()
  })

  it("default boolean value is false (unchecked)", () => {
    render(<AdapterForm schema={BOOL_SCHEMA} onSubmit={jest.fn()} />)
    const sw = screen.getByRole("switch") as HTMLButtonElement
    expect(sw.getAttribute("data-state")).toBe("unchecked")
  })

  it("accepts initialValues for boolean fields", () => {
    render(
      <AdapterForm schema={BOOL_SCHEMA} initialValues={{ enabled: true }} onSubmit={jest.fn()} />
    )
    const sw = screen.getByRole("switch") as HTMLButtonElement
    expect(sw.getAttribute("data-state")).toBe("checked")
  })
})

describe("AdapterForm — enum fields", () => {
  it("renders a Select for enum properties", () => {
    render(<AdapterForm schema={ENUM_SCHEMA} onSubmit={jest.fn()} />)
    // The select trigger should show the first option
    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })
})

describe("AdapterForm — cancel button", () => {
  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = jest.fn()
    render(<AdapterForm schema={STRING_SCHEMA} onSubmit={jest.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("does not render Cancel button when onCancel is not provided", () => {
    render(<AdapterForm schema={STRING_SCHEMA} onSubmit={jest.fn()} />)
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument()
  })
})

describe("AdapterForm — submit label", () => {
  it("uses custom submitLabel", () => {
    render(<AdapterForm schema={STRING_SCHEMA} onSubmit={jest.fn()} submitLabel="Create Adapter" />)
    expect(screen.getByRole("button", { name: /create adapter/i })).toBeInTheDocument()
  })
})
