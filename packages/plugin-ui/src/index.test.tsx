import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { render, screen } from "@testing-library/react"

import * as kit from "./index"
import { Alert, AlertDescription, AlertTitle } from "./alert"
import { Badge } from "./badge"
import { Button } from "./button"
import { Card, CardContent, CardHeader, CardTitle } from "./card"
import { Checkbox } from "./checkbox"
import { cn } from "./cn"
import { Input } from "./input"
import { Label } from "./label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"

const SRC_DIR = __dirname

/**
 * The package's whole reason to exist is that a plugin author outside this repo
 * can install it and typecheck. One stray `@/…` import silently breaks
 * `pnpm build:packages` — and, worse, only for people who don't have the app
 * checked out. Pin it here so the failure is local and immediate.
 */
describe("standalone resolution", () => {
  const sources = readdirSync(SRC_DIR).filter(
    (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test.")
  )

  it("ships more than just the barrel", () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  it("publishes only the host-resolvable author entry as a stable package surface", () => {
    const manifest = JSON.parse(readFileSync(join(SRC_DIR, "..", "package.json"), "utf8")) as {
      version: string
      private?: boolean
      main: string
      module: string
      types: string
      exports: Record<string, unknown>
      publishConfig?: { access?: string }
    }
    expect(manifest.version).toBe("0.2.0")
    expect(manifest.private).toBe(false)
    expect(manifest.main).toBe("./dist/index.cjs")
    expect(manifest.module).toBe("./dist/index.js")
    expect(manifest.types).toBe("./dist/index.d.ts")
    expect(Object.hasOwn(manifest.exports, ".")).toBe(true)
    expect(Object.hasOwn(manifest.exports, "./*")).toBe(false)
    expect(manifest.publishConfig?.access).toBe("public")
  })

  it.each(sources)("%s imports no app-aliased path", (file) => {
    const code = readFileSync(join(SRC_DIR, file), "utf8")
    const appImports = [...code.matchAll(/from\s+"(@\/[^"]+)"/g)].map((m) => m[1])
    expect(appImports).toEqual([])
  })

  it.each(sources)("%s does not import react-dom", (file) => {
    // `react-dom` is deliberately absent from the host's shared-module
    // whitelist so a plugin cannot portal out of its slot. Importing it here
    // would hand it back through the kit.
    const code = readFileSync(join(SRC_DIR, file), "utf8")
    expect(code).not.toMatch(/from\s+"react-dom(?:\/[^"]*)?"/)
  })
})

describe("barrel", () => {
  it("exports every component the README documents", () => {
    for (const name of [
      "Alert",
      "AlertDescription",
      "AlertTitle",
      "Badge",
      "Button",
      "Card",
      "CardContent",
      "CardHeader",
      "CardTitle",
      "Checkbox",
      "CopyFeedbackIcon",
      "Dialog",
      "DialogContent",
      "DialogTitle",
      "Form",
      "FormField",
      "Input",
      "Label",
      "PluginImage",
      "Select",
      "SelectContent",
      "SelectItem",
      "SelectTrigger",
      "SelectValue",
      "Tabs",
      "TabsContent",
      "TabsList",
      "TabsTrigger",
      "ToolCard",
      "Tooltip",
      "TooltipContent",
      "TooltipProvider",
      "TooltipTrigger",
      "Toaster",
      "toast",
      "cn",
      "parseToolOutput",
      "useCopy",
      "useParsedToolOutput",
    ]) {
      expect(kit).toHaveProperty(name)
    }
  })
})

describe("cn", () => {
  it("lets a later tailwind utility win over an earlier one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4")
  })

  it("drops falsy entries", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c")
  })
})

describe("components", () => {
  it("renders a Button that merges caller classes and keeps its data-slot", () => {
    render(<Button className="px-8">Run</Button>)
    const button = screen.getByRole("button", { name: "Run" })
    expect(button).toHaveAttribute("data-slot", "button")
    expect(button).toHaveAttribute("data-variant", "default")
    expect(button.className).toContain("px-8")
    // cn() resolved the conflict rather than emitting both paddings.
    expect(button.className).not.toContain("px-4")
  })

  it("renders a Button as its child when asChild is set", () => {
    render(
      <Button asChild>
        <a href="/x">Go</a>
      </Button>
    )
    expect(screen.getByRole("link", { name: "Go" })).toHaveAttribute("data-slot", "button")
  })

  it("renders Badge variants", () => {
    render(<Badge variant="destructive">Bad</Badge>)
    expect(screen.getByText("Bad")).toHaveAttribute("data-variant", "destructive")
  })

  it("renders an Alert with its title and description", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Broke</AlertTitle>
        <AlertDescription>Details</AlertDescription>
      </Alert>
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("Broke")).toHaveAttribute("data-slot", "alert-title")
    expect(screen.getByText("Details")).toHaveAttribute("data-slot", "alert-description")
  })

  it("renders a Card tree", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardContent>Body</CardContent>
      </Card>
    )
    expect(screen.getByText("Title")).toHaveAttribute("data-slot", "card-title")
    expect(screen.getByText("Body")).toHaveAttribute("data-slot", "card-content")
  })

  it("associates a Label with an Input", () => {
    render(
      <>
        <Label htmlFor="name">Name</Label>
        <Input id="name" defaultValue="cognia" />
      </>
    )
    expect(screen.getByLabelText("Name")).toHaveValue("cognia")
  })

  it("renders a Checkbox reflecting its checked state", () => {
    render(<Checkbox checked aria-label="Enable" onCheckedChange={() => {}} />)
    expect(screen.getByRole("checkbox", { name: "Enable" })).toHaveAttribute(
      "data-state",
      "checked"
    )
  })

  it("renders only the active Tabs panel", () => {
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">First</TabsContent>
        <TabsContent value="two">Second</TabsContent>
      </Tabs>
    )
    expect(screen.getByText("First")).toBeInTheDocument()
    expect(screen.queryByText("Second")).not.toBeInTheDocument()
  })
})

/**
 * These components carry no literal colors — they reference the host's CSS
 * custom properties so a plugin inherits the user's theme for free. A hex or
 * rgb() literal creeping in is how that silently stops being true.
 */
describe("theme inheritance", () => {
  const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith(".tsx") && !f.includes(".test."))

  it.each(sources)("%s hard-codes no color literal", (file) => {
    const code = readFileSync(join(SRC_DIR, file), "utf8")
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(code).not.toMatch(/\brgba?\(/)
    expect(code).not.toMatch(/\boklch\(/)
  })
})
