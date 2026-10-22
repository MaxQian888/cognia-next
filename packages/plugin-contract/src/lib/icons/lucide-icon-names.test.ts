import {
  hasLucideExport,
  hasLucideIcon,
  lucideExportCatalogName,
  toCatalogIconName,
} from "./lucide-icon-names"

describe("lucide icon names", () => {
  it("answers icon and export membership", () => {
    expect(hasLucideIcon("FileText")).toBe(true)
    expect(hasLucideIcon("FileTextIcon")).toBe(false)
    expect(hasLucideExport("FileTextIcon")).toBe(true)
    expect(hasLucideExport("constructor")).toBe(false)
    expect(lucideExportCatalogName("toString")).toBeUndefined()
  })

  it("resolves exact, exported and kebab-case spellings to a catalog name", () => {
    expect(toCatalogIconName("FileText")).toBe("FileText")
    expect(toCatalogIconName("FileTextIcon")).toBe(lucideExportCatalogName("FileTextIcon"))
    expect(toCatalogIconName("file-text")).toBe("FileText")
    expect(toCatalogIconName("history")).toBe(lucideExportCatalogName("History"))
    expect(toCatalogIconName("not-an-icon")).toBeNull()
    expect(toCatalogIconName("constructor")).toBeNull()
  })
})
