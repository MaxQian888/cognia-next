import React from "react"
import { render } from "@testing-library/react"

import { CliI18nProvider } from "../i18n"

import { SlashPalette } from "./SlashPalette"

describe("SlashPalette", () => {
  it("renders matches with the highlighted row and descriptions", () => {
    const { container } = render(
      <SlashPalette
        matches={[
          { name: "model", description: "switch the model", category: "config" },
          { name: "mode", description: "switch the mode", category: "config" },
        ]}
        index={1}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("/model")
    expect(text).toContain("switch the model")
    expect(text).toContain("❯ /mode")
  })

  it("shows the active search and command argument hints", () => {
    const { container } = render(
      <SlashPalette
        query="co"
        matches={[
          {
            name: "copy",
            description: "copy a reply",
            argumentHint: "[n|code|tool|user]",
            category: "chat",
          },
        ]}
        index={0}
        width={50}
      />
    )
    expect(container.textContent).toContain("Search: co")
    expect(container.textContent).toContain("/copy [n|code|tool|user]")
  })

  it("renders nothing when there are no matches", () => {
    const { container } = render(<SlashPalette matches={[]} index={0} />)
    expect(container.textContent).toBe("")
  })

  it("windows a long match list and shows scroll hints", () => {
    const matches = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`,
      description: `does ${i}`,
      category: "config" as const,
    }))
    const { container } = render(<SlashPalette matches={matches} index={15} maxRows={5} />)
    const text = container.textContent ?? ""
    expect(text).toContain("❯ /cmd15") // selection visible
    expect(text).toContain("↑") // hidden above
    expect(text).toContain("↓") // hidden below
    expect(text).not.toContain("/cmd0 ") // scrolled out of view
  })
  it("offers a concise submenu instead of listing all arguments on a root row", () => {
    const { container } = render(
      <SlashPalette
        query="skil"
        index={0}
        matches={[
          {
            name: "skill",
            category: "cognia",
            description: "manage skills",
            argumentHint: "<panel | list | enable | disable>",
            subcommands: ["panel", "list", "enable", "disable"].map((name) => ({
              name,
              description: name,
              handler: () => ({ kind: "notice", message: name }),
            })),
          },
        ]}
      />
    )
    expect(container.textContent).toContain("/skill 4 actions ›")
    expect(container.textContent).toContain("Enter open")
    expect(container.textContent).not.toContain("panel | list")
  })

  it("shows the parent breadcrumb, local verb and its own argument hint", () => {
    const { container } = render(
      <SlashPalette
        query="skill en"
        index={0}
        matches={[
          {
            name: "skill enable",
            category: "cognia",
            description: "enable a skill",
            argumentHint: "<id>",
          },
        ]}
      />
    )
    expect(container.textContent).toContain("/skill › en")
    expect(container.textContent).toContain("❯ enable <id>")
    expect(container.textContent).toContain("Enter choose")
    expect(container.textContent).not.toContain("/skill enable")
  })

  it("localizes the empty submenu query and compact keyboard hints", () => {
    const { container } = render(
      <CliI18nProvider locale="zh-CN">
        <SlashPalette
          width={40}
          query="skill "
          index={1}
          maxRows={1}
          matches={[
            { name: "skill list", category: "cognia", description: "列出技能" },
            { name: "skill enable", category: "cognia", description: "启用技能" },
            { name: "skill disable", category: "cognia", description: "禁用技能" },
          ]}
        />
      </CliI18nProvider>
    )
    expect(container.textContent).toContain("/skill › 子命令")
    expect(container.textContent).toContain("↑↓ · Tab · Enter 选择")
    expect(container.textContent).toContain("↑ 还有 1 项")
    expect(container.textContent).toContain("↓ 还有 1 项")
    expect(container.textContent).not.toContain("❯ list")
  })
})
