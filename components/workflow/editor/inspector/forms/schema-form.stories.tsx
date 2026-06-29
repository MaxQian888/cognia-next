import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchemaForm } from "./schema-form"

// Generic JSON-Schema → form renderer for plugin-contributed nodes. Drives
// inputs/selects/switches/tag-lists off the schema and falls back to a JSON
// textarea for anything unrecognised. Controlled so edits round-trip.
function Controlled({
  schema,
  initial = {},
}: {
  schema: React.ComponentProps<typeof SchemaForm>["schema"]
  initial?: Record<string, unknown>
}) {
  const [params, setParams] = React.useState<Record<string, unknown>>(initial)
  return (
    <div className="w-[380px]">
      <SchemaForm schema={schema} params={params} onChange={setParams} />
    </div>
  )
}

const richSchema = {
  type: "object" as const,
  required: ["endpoint", "method"],
  properties: {
    endpoint: {
      type: "string" as const,
      title: "Endpoint",
      description: "Absolute URL to call.",
      format: "url",
      examples: ["https://api.example.com/v1/send"],
    },
    method: {
      type: "string" as const,
      title: "Method",
      enum: ["GET", "POST", "PUT", "DELETE"],
      default: "POST",
    },
    timeoutMs: {
      type: "integer" as const,
      title: "Timeout (ms)",
      minimum: 0,
      maximum: 60_000,
      default: 10_000,
    },
    retryOnFailure: { type: "boolean" as const, title: "Retry on failure" },
    headers: {
      type: "array" as const,
      title: "Header keys",
      items: { type: "string" as const },
    },
    bodyTemplate: {
      type: "string" as const,
      title: "Body template",
      format: "expression",
      description: "Supports {{ }} expressions.",
    },
  },
}

const meta = {
  title: "Workflow/Editor/Inspector/Forms/SchemaForm",
  component: SchemaForm,
  parameters: { layout: "padded" },
  args: { schema: richSchema, params: {}, onChange: fn() },
} satisfies Meta<typeof SchemaForm>

export default meta
type Story = StoryObj<typeof meta>

// Object schema covering string/url, enum-select, integer, boolean, tag-list,
// and expression fields.
export const RichObject: Story = {
  render: () => (
    <Controlled
      schema={richSchema}
      initial={{
        endpoint: "https://api.example.com/v1/send",
        method: "POST",
        timeoutMs: 10_000,
        retryOnFailure: true,
        headers: ["Authorization", "Content-Type"],
      }}
    />
  ),
}

// A non-object schema falls back to a single JSON textarea.
export const JsonFallback: Story = {
  render: () => (
    <Controlled
      schema={{ type: "array", items: { type: "string" } }}
      initial={{ _root: ["a", "b"] }}
    />
  ),
}
