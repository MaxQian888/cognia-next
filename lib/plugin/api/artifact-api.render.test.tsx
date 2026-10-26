import { createElement, type ComponentType } from "react"
import { render, screen } from "@testing-library/react"
import {
  getArtifactPreviewComponent,
  getBuiltinRenderers,
  getDefaultArtifactRenderer,
} from "./artifact-api"

// Keep the CRUD suite in Node; only component getters need a DOM environment.
jest.mock("@/stores/artifact/artifact-store", () => ({}))
jest.mock("@/stores/chat", () => ({}))
jest.mock("@/lib/artifacts", () => ({}))
jest.mock("../core/logger", () => ({}))
jest.mock("./api-permission-gate", () => ({}))

jest.mock("@/components/artifacts/artifact-renderers", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return Object.fromEntries(
    [
      "MermaidRenderer",
      "ChartRenderer",
      "MathRenderer",
      "MarkdownRenderer",
      "CodeRenderer",
      "ArtifactRenderer",
    ].map((name) => [
      name,
      ({ fixtureValue }: { fixtureValue: string }) =>
        React.createElement("article", { "aria-label": name }, fixtureValue),
    ])
  )
})

jest.mock("@/components/artifacts/artifact-preview", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    ArtifactPreview: ({ fixtureValue }: { fixtureValue: string }) =>
      React.createElement("article", { "aria-label": "ArtifactPreview" }, fixtureValue),
  }
})

describe("lazy artifact component getters", () => {
  it.each([
    ...Object.entries(getBuiltinRenderers()),
    ["ArtifactRenderer", getDefaultArtifactRenderer()],
    ["ArtifactPreview", getArtifactPreviewComponent()],
  ] as const)("loads %s and forwards its props on render", async (name, component) => {
    const Fixture = component as unknown as ComponentType<{ fixtureValue: string }>
    render(createElement(Fixture, { fixtureValue: `${name} props delivered` }))

    expect(await screen.findByRole("article", { name })).toHaveTextContent(
      `${name} props delivered`
    )
  })
})
