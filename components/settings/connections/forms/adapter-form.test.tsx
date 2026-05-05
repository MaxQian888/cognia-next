/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AdapterForm, type JsonSchema } from "./adapter-form"

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

  it("renders secret fields as password inputs", () => {
    render(<AdapterForm schema={MIXED_SCHEMA} secretFields={["token"]} onSubmit={jest.fn()} />)
    const tokenInput = screen.getByLabelText(/bot token/i) as HTMLInputElement
    expect(tokenInput.type).toBe("password")
  })

  it("calls onSubmit with non-secret values + secrets separately", async () => {
    const handleSubmit = jest.fn()
    render(<AdapterForm schema={MIXED_SCHEMA} secretFields={["token"]} onSubmit={handleSubmit} />)

    // Fill in the token (secret)
    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "my-secret-token" },
    })
    // Submit the form
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }), // non-secrets
        expect.objectContaining({ token: "my-secret-token" }) // secrets
      )
    })
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
