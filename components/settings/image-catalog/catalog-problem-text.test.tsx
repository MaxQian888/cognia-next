import { render, screen } from "@testing-library/react"

import { CatalogProblemText, catalogProblemKey } from "./catalog-problem-text"
import en from "@/i18n/messages/en/settings/imageCatalog.json"
import zh from "@/i18n/messages/zh-CN/settings/imageCatalog.json"

describe("catalogProblemKey", () => {
  it("names the sentence for each code the Host refuses a catalog write with", () => {
    for (const code of [
      "catalog_entry_duplicate",
      "catalog_entry_invalid",
      "catalog_entry_unpinned",
      "catalog_registry_not_allowlisted",
      "catalog_size_class_unknown",
      "environment_record_not_found",
      "tenant_entry_scope",
    ]) {
      expect(catalogProblemKey(code)).not.toBe("unknown")
    }
  })

  it("treats both ways of saying 'not an admin' alike", () => {
    expect(catalogProblemKey("forbidden")).toBe("forbidden")
    expect(catalogProblemKey("scope_denied")).toBe("forbidden")
  })

  it("falls back for a code this build has no sentence for", () => {
    expect(catalogProblemKey("something_new")).toBe("unknown")
  })

  it("has a sentence in every locale for every key it can return", () => {
    const keys = new Set(
      [
        "x",
        "forbidden",
        "catalog_entry_duplicate",
        "image_reference_invalid",
        "upstream_unavailable",
      ]
        .map(catalogProblemKey)
        .concat(Object.keys(en.errors))
    )
    for (const key of keys) {
      expect(en.errors).toHaveProperty(key)
      expect(zh.errors).toHaveProperty(key)
    }
  })
})

describe("CatalogProblemText", () => {
  it("shows the page's sentence and the Host's own words", () => {
    render(
      <CatalogProblemText
        problem={{ code: "catalog_registry_not_allowlisted", message: "evil.io is not allowed" }}
      />
    )
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(en.errors.catalogRegistryNotAllowlisted)
    expect(alert).toHaveTextContent("Host: evil.io is not allowed")
  })

  it("still shows the Host's words for an unknown code", () => {
    render(<CatalogProblemText problem={{ code: "brand_new", message: "because" }} />)
    expect(screen.getByRole("alert")).toHaveTextContent(en.errors.unknown)
    expect(screen.getByRole("alert")).toHaveTextContent("because")
  })

  it("omits the Host line when the Host said nothing", () => {
    render(<CatalogProblemText problem={{ code: "forbidden", message: "" }} />)
    expect(screen.queryByText(/^Host:/)).not.toBeInTheDocument()
  })
})
