jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
}))

import { redirect } from "next/navigation"
import Home from "./page"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("docs landing redirects", () => {
  it.each(["zh", "en"])("preserves the %s locale at the landing page", async (lang) => {
    await Home({ params: Promise.resolve({ lang }) })

    expect(redirect).toHaveBeenCalledWith(`/${lang}/docs`)
  })

  it("redirects the bare docs root on static hosting", () => {
    const redirects = readFileSync(resolve(__dirname, "../../public/_redirects"), "utf8")

    expect(redirects.split("\n")).toContain("/docs /zh/docs 302")
  })
})
