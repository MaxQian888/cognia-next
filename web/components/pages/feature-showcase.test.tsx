import { render, screen } from "@testing-library/react"

import { FeatureShowcase } from "./feature-showcase"

const copy = {
  title: "Core workspace capabilities",
  subtitle: "Four product systems that stay connected to the same task.",
  items: [
    {
      key: "context",
      title: "Context workbench",
      body: "Collect the files and resources the task is allowed to use.",
      detail: "Files · resources · instructions",
      docsPath: "/docs/ui/context-workbench",
    },
    {
      key: "surfaces",
      title: "Interactive surfaces",
      body: "Turn an agent result into a reviewable interface.",
      detail: "Canvas · A2UI · artifacts",
      docsPath: "/docs/subsystems/a2ui",
    },
    {
      key: "connections",
      title: "Connected inbox",
      body: "Bring external conversations back to one work record.",
      detail: "Inbox · adapters · dispatch",
      docsPath: "/docs/subsystems/platform-connectors",
    },
    {
      key: "automation",
      title: "Durable automation",
      body: "Schedule work and retain the state of every run.",
      detail: "Scheduler · goals · history",
      docsPath: "/docs/subsystems/scheduler",
    },
  ],
}

describe("FeatureShowcase", () => {
  it("renders four complete capability proofs", () => {
    render(
      <FeatureShowcase
        copy={copy}
        learnMore="Read the docs"
        locale="en"
        docsOrigin="https://docs.example"
      />
    )

    expect(screen.getByRole("heading", { level: 2, name: copy.title })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(4)
    for (const item of copy.items) {
      expect(screen.getByRole("heading", { level: 3, name: item.title })).toBeInTheDocument()
      expect(screen.getByText(item.detail)).toBeInTheDocument()
    }
  })

  it("resolves documentation links for the active locale", () => {
    render(
      <FeatureShowcase
        copy={copy}
        learnMore="Read the docs"
        locale="zh"
        docsOrigin="https://docs.example"
      />
    )

    expect(screen.getAllByRole("link")[0]).toHaveAttribute(
      "href",
      `https://docs.example/zh${copy.items[0].docsPath}`
    )
  })

  it("keeps additional proofs readable when no documentation link is supplied", () => {
    const additionalItem = {
      key: "portable",
      title: "Portable workspace",
      body: "Keep the complete proof visible without depending on a link.",
      detail: "Export · restore · continue",
    }

    render(
      <FeatureShowcase
        copy={{ ...copy, items: [...copy.items, additionalItem] }}
        learnMore="Read the docs"
        locale="en"
      />
    )

    expect(
      screen.getByRole("heading", { level: 3, name: additionalItem.title })
    ).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(5)
    expect(screen.getAllByRole("link")).toHaveLength(copy.items.length)
  })
})
