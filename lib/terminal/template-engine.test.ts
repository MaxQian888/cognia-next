import {
  parseTemplateVars,
  hasInteractiveVars,
  hasTemplateVars,
  resolveTemplate,
  formatDate,
} from "./template-engine"

describe("template-engine", () => {
  describe("parseTemplateVars", () => {
    it("returns empty array for strings with no variables", () => {
      expect(parseTemplateVars("echo hello")).toEqual([])
      expect(parseTemplateVars("")).toEqual([])
    })

    it("parses ${input:label}", () => {
      const vars = parseTemplateVars("docker exec -it ${input:container} bash")
      expect(vars).toHaveLength(1)
      expect(vars[0]).toMatchObject({
        raw: "${input:container}",
        kind: "input",
        label: "container",
      })
      expect(vars[0].defaultValue).toBeUndefined()
    })

    it("parses ${input:label:default}", () => {
      const vars = parseTemplateVars("ssh ${input:user:root}@server")
      expect(vars).toHaveLength(1)
      expect(vars[0]).toMatchObject({
        raw: "${input:user:root}",
        kind: "input",
        label: "user",
        defaultValue: "root",
      })
    })

    it("parses ${select:label:opt1,opt2,opt3}", () => {
      const vars = parseTemplateVars("git checkout ${select:branch:main,staging,dev}")
      expect(vars).toHaveLength(1)
      expect(vars[0]).toMatchObject({
        raw: "${select:branch:main,staging,dev}",
        kind: "select",
        label: "branch",
        options: ["main", "staging", "dev"],
      })
    })

    it("parses ${env:NAME}", () => {
      const vars = parseTemplateVars("echo ${env:HOME}")
      expect(vars).toHaveLength(1)
      expect(vars[0]).toMatchObject({ raw: "${env:HOME}", kind: "env", label: "HOME" })
    })

    it("parses ${cwd}", () => {
      const vars = parseTemplateVars("ls ${cwd}")
      expect(vars).toHaveLength(1)
      expect(vars[0]).toMatchObject({ raw: "${cwd}", kind: "cwd", label: "cwd" })
    })

    it("parses ${clipboard}", () => {
      const vars = parseTemplateVars("echo ${clipboard}")
      expect(vars).toHaveLength(1)
      expect(vars[0]).toMatchObject({ raw: "${clipboard}", kind: "clipboard", label: "clipboard" })
    })

    it("parses ${date:FORMAT}", () => {
      const vars = parseTemplateVars("touch log-${date:YYYY-MM-DD}.txt")
      expect(vars).toHaveLength(1)
      expect(vars[0]).toMatchObject({
        raw: "${date:YYYY-MM-DD}",
        kind: "date",
        label: "YYYY-MM-DD",
      })
    })

    it("deduplicates identical tokens", () => {
      const vars = parseTemplateVars("${input:x} and ${input:x}")
      expect(vars).toHaveLength(1)
    })

    it("handles multiple different variables in one template", () => {
      const template = "deploy ${select:env:test,prod} --tag ${input:tag:latest} at ${date:HH:mm}"
      const vars = parseTemplateVars(template)
      expect(vars).toHaveLength(3)
      expect(vars.map((v) => v.kind)).toEqual(["select", "input", "date"])
    })

    it("handles ${input:} with empty label as fallback", () => {
      const vars = parseTemplateVars("${input:}")
      expect(vars[0].label).toBe("Value")
    })

    it("handles ${select:} with no options", () => {
      const vars = parseTemplateVars("${select:choice}")
      expect(vars[0]).toMatchObject({ kind: "select", label: "choice", options: [] })
    })
  })

  describe("hasInteractiveVars", () => {
    it("returns true for templates with input variables", () => {
      expect(hasInteractiveVars("${input:name}")).toBe(true)
    })

    it("returns true for templates with select variables", () => {
      expect(hasInteractiveVars("${select:opt:a,b}")).toBe(true)
    })

    it("returns false for templates with only auto-resolvable variables", () => {
      expect(hasInteractiveVars("${env:HOME} ${cwd} ${date:YYYY}")).toBe(false)
    })

    it("returns false for templates without variables", () => {
      expect(hasInteractiveVars("echo hello")).toBe(false)
    })
  })

  describe("hasTemplateVars", () => {
    it("returns true when any variable exists", () => {
      expect(hasTemplateVars("${cwd}")).toBe(true)
      expect(hasTemplateVars("${env:PATH}")).toBe(true)
    })

    it("returns false for plain text", () => {
      expect(hasTemplateVars("just text")).toBe(false)
    })
  })

  describe("resolveTemplate", () => {
    it("resolves input variables from user values", () => {
      const result = resolveTemplate("docker exec -it ${input:name} bash", {
        "${input:name}": "my-container",
      })
      expect(result).toBe("docker exec -it my-container bash")
    })

    it("resolves select variables from user values", () => {
      const result = resolveTemplate("git checkout ${select:branch:main,dev}", {
        "${select:branch:main,dev}": "dev",
      })
      expect(result).toBe("git checkout dev")
    })

    it("resolves ${env:NAME} from context", () => {
      const result = resolveTemplate("cd ${env:HOME}", {}, { env: { HOME: "/Users/me" } })
      expect(result).toBe("cd /Users/me")
    })

    it("resolves ${cwd} from context", () => {
      const result = resolveTemplate("ls ${cwd}", {}, { cwd: "/project" })
      expect(result).toBe("ls /project")
    })

    it("resolves ${clipboard} from context", () => {
      const result = resolveTemplate("echo '${clipboard}'", {}, { clipboard: "copied text" })
      expect(result).toBe("echo 'copied text'")
    })

    it("resolves ${date:FORMAT} with actual date formatting", () => {
      const result = resolveTemplate("${date:YYYY-MM-DD}", {})
      // Should be a date-like string
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it("falls back to empty string for missing env var", () => {
      const result = resolveTemplate("${env:MISSING}", {}, { env: {} })
      expect(result).toBe("")
    })

    it("falls back to empty string for missing cwd", () => {
      const result = resolveTemplate("${cwd}", {}, { cwd: null })
      expect(result).toBe("")
    })

    it("leaves unresolved interactive vars as-is", () => {
      const result = resolveTemplate("${input:name}", {})
      expect(result).toBe("${input:name}")
    })

    it("handles mixed resolvable and user-supplied variables", () => {
      const template = "deploy ${input:app} to ${env:CLUSTER} at ${date:HH:mm}"
      const result = resolveTemplate(
        template,
        { "${input:app}": "web" },
        { env: { CLUSTER: "prod-us-1" } }
      )
      expect(result).toMatch(/^deploy web to prod-us-1 at \d{2}:\d{2}$/)
    })
  })

  describe("formatDate", () => {
    it("formats all tokens correctly", () => {
      const date = new Date(2026, 5, 15, 9, 7, 3) // June 15, 2026 09:07:03
      expect(formatDate("YYYY-MM-DD", date)).toBe("2026-06-15")
      expect(formatDate("HH:mm:ss", date)).toBe("09:07:03")
      expect(formatDate("YYYY", date)).toBe("2026")
    })

    it("pads single-digit values", () => {
      const date = new Date(2026, 0, 5, 3, 1, 2) // Jan 5, 2026 03:01:02
      expect(formatDate("MM-DD HH:mm:ss", date)).toBe("01-05 03:01:02")
    })
  })
})
