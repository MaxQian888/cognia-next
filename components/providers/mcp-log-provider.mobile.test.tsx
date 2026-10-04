import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { McpLogProvider } from "./mcp-log-provider.mobile"

describe("McpLogProvider mobile compilation boundary", () => {
  it("preserves children without adding a wrapper", () => {
    const { container } = render(
      <McpLogProvider>
        <main>app</main>
      </McpLogProvider>
    )
    expect(container.innerHTML).toBe("<main>app</main>")
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "mcp-log-provider.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
