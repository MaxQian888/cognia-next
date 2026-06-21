/**
 * Code Parser - Extract structure and content from code files
 */

export interface CodeFunction {
  name: string
  startLine: number
  endLine: number
  signature: string
  docstring?: string
}

export interface CodeClass {
  name: string
  startLine: number
  endLine: number
  methods: CodeFunction[]
  docstring?: string
}

export interface CodeImport {
  module: string
  items?: string[]
  line: number
}

export interface CodeParseResult {
  language: string
  imports: CodeImport[]
  functions: CodeFunction[]
  classes: CodeClass[]
  comments: string[]
  content: string
}

/**
 * Detect programming language from file extension
 */
export function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || ""

  const languageMap: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    go: "go",
    rs: "rust",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    swift: "swift",
    scala: "scala",
    r: "r",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    md: "markdown",
    vue: "vue",
    svelte: "svelte",
  }

  return languageMap[ext] || "text"
}

/**
 * Extract imports from JavaScript/TypeScript
 */
function extractJSImports(content: string): CodeImport[] {
  const imports: CodeImport[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // import { x } from 'module'
    const namedImportMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/)
    if (namedImportMatch) {
      imports.push({
        module: namedImportMatch[2],
        items: namedImportMatch[1].split(",").map((s) => s.trim()),
        line: i + 1,
      })
      continue
    }

    // import x from 'module'
    const defaultImportMatch = line.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/)
    if (defaultImportMatch) {
      imports.push({
        module: defaultImportMatch[2],
        items: [defaultImportMatch[1]],
        line: i + 1,
      })
      continue
    }

    // import 'module'
    const sideEffectMatch = line.match(/import\s+['"]([^'"]+)['"]/)
    if (sideEffectMatch) {
      imports.push({
        module: sideEffectMatch[1],
        line: i + 1,
      })
    }
  }

  return imports
}

/**
 * Extract imports from Python
 */
function extractPythonImports(content: string): CodeImport[] {
  const imports: CodeImport[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // from module import x, y
    const fromImportMatch = line.match(/from\s+(\S+)\s+import\s+(.+)/)
    if (fromImportMatch) {
      imports.push({
        module: fromImportMatch[1],
        items: fromImportMatch[2].split(",").map((s) => s.trim()),
        line: i + 1,
      })
      continue
    }

    // import module
    const importMatch = line.match(/^import\s+(.+)/)
    if (importMatch) {
      const modules = importMatch[1].split(",").map((s) => s.trim())
      for (const mod of modules) {
        imports.push({
          module: mod.split(" as ")[0],
          line: i + 1,
        })
      }
    }
  }

  return imports
}

/**
 * Extract functions from JavaScript/TypeScript
 */
function extractJSFunctions(content: string): CodeFunction[] {
  const functions: CodeFunction[] = []
  const lines = content.split("\n")

  const functionPatterns = [
    // function name() {}
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
    // const name = () => {}
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/,
    // const name = function() {}
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/,
  ]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    for (const pattern of functionPatterns) {
      const match = line.match(pattern)
      if (match) {
        // Find end of function (simplified - counts braces)
        let braceCount = 0
        let endLine = i
        let started = false

        for (let j = i; j < lines.length; j++) {
          const l = lines[j]
          for (const char of l) {
            if (char === "{") {
              braceCount++
              started = true
            } else if (char === "}") {
              braceCount--
            }
          }
          if (started && braceCount === 0) {
            endLine = j
            break
          }
        }

        // Check for JSDoc comment above
        let docstring: string | undefined
        if (i > 0 && lines[i - 1].trim().endsWith("*/")) {
          let docStart = i - 1
          while (docStart > 0 && !lines[docStart].includes("/**")) {
            docStart--
          }
          docstring = lines.slice(docStart, i).join("\n")
        }

        functions.push({
          name: match[1],
          startLine: i + 1,
          endLine: endLine + 1,
          signature: line,
          docstring,
        })
        break
      }
    }
  }

  return functions
}

/**
 * Extract functions from Python
 */
function extractPythonFunctions(content: string): CodeFunction[] {
  const functions: CodeFunction[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/)

    if (match) {
      // Find end of function (by indentation)
      const indent = line.search(/\S/)
      let endLine = i

      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === "") continue
        const currentIndent = l.search(/\S/)
        if (currentIndent <= indent && l.trim() !== "") {
          endLine = j - 1
          break
        }
        endLine = j
      }

      // Check for docstring
      let docstring: string | undefined
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim()
        if (nextLine.startsWith('"""') || nextLine.startsWith("'''")) {
          const quote = nextLine.slice(0, 3)
          let docEnd = i + 1
          if (!nextLine.slice(3).includes(quote)) {
            for (let j = i + 2; j < lines.length; j++) {
              if (lines[j].includes(quote)) {
                docEnd = j
                break
              }
            }
          }
          docstring = lines.slice(i + 1, docEnd + 1).join("\n")
        }
      }

      functions.push({
        name: match[1],
        startLine: i + 1,
        endLine: endLine + 1,
        signature: line.trim(),
        docstring,
      })
    }
  }

  return functions
}

/**
 * Extract comments from code
 */
function extractComments(content: string, language: string): string[] {
  const comments: string[] = []

  if (
    [
      "javascript",
      "typescript",
      "java",
      "cpp",
      "c",
      "csharp",
      "go",
      "rust",
      "swift",
      "kotlin",
    ].includes(language)
  ) {
    // Single-line comments
    const singleLineMatches = content.match(/\/\/.*$/gm) || []
    comments.push(...singleLineMatches.map((c) => c.replace(/^\/\/\s*/, "")))

    // Multi-line comments
    const multiLineMatches = content.match(/\/\*[\s\S]*?\*\//g) || []
    comments.push(
      ...multiLineMatches.map((c) =>
        c
          .replace(/^\/\*\s*/, "")
          .replace(/\s*\*\/$/, "")
          .replace(/^\s*\*\s*/gm, "")
      )
    )
  } else if (language === "python") {
    // Single-line comments
    const singleLineMatches = content.match(/#.*$/gm) || []
    comments.push(...singleLineMatches.map((c) => c.replace(/^#\s*/, "")))

    // Docstrings
    const docstringMatches = content.match(/"""[\s\S]*?"""|'''[\s\S]*?'''/g) || []
    comments.push(
      ...docstringMatches.map((c) =>
        c
          .replace(/^["']{3}/, "")
          .replace(/["']{3}$/, "")
          .trim()
      )
    )
  }

  return comments.filter((c) => c.trim().length > 0)
}

/**
 * Extract classes from JavaScript/TypeScript
 */
function extractJSClasses(content: string): CodeClass[] {
  const classes: CodeClass[] = []
  const lines = content.split("\n")

  const classPattern =
    /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const match = line.match(classPattern)

    if (match) {
      const className = match[1]
      const startLine = i

      // Find end of class (count braces)
      let braceCount = 0
      let endLine = i
      let started = false

      for (let j = i; j < lines.length; j++) {
        const l = lines[j]
        for (const char of l) {
          if (char === "{") {
            braceCount++
            started = true
          } else if (char === "}") {
            braceCount--
          }
        }
        if (started && braceCount === 0) {
          endLine = j
          break
        }
      }

      // Extract methods within class
      const classContent = lines.slice(startLine, endLine + 1).join("\n")
      const methods = extractClassMethods(classContent, startLine)

      // Check for JSDoc comment above class
      let docstring: string | undefined
      if (i > 0 && lines[i - 1].trim().endsWith("*/")) {
        let docStart = i - 1
        while (docStart > 0 && !lines[docStart].includes("/**")) {
          docStart--
        }
        docstring = lines.slice(docStart, i).join("\n")
      }

      classes.push({
        name: className,
        startLine: startLine + 1,
        endLine: endLine + 1,
        methods,
        docstring,
      })
    }
  }

  return classes
}

/**
 * Extract methods from a class body
 */
function extractClassMethods(classContent: string, classStartLine: number): CodeFunction[] {
  const methods: CodeFunction[] = []
  const lines = classContent.split("\n")

  const methodPatterns = [
    // Regular method: methodName() {} or async methodName() {}
    /^\s*(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*\{/,
    // Arrow method in class: methodName = () => {} or methodName = async () => {}
    /^\s*(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\S+)?\s*=>/,
    // Getter/setter: get/set methodName() {}
    /^\s*(?:get|set)\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*\{/,
    // Static method: static methodName() {}
    /^\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+)?\s*\{/,
  ]

  for (let i = 1; i < lines.length - 1; i++) {
    // Skip first and last lines (class declaration and closing brace)
    const line = lines[i]

    for (const pattern of methodPatterns) {
      const match = line.match(pattern)
      if (
        match &&
        match[1] !== "constructor" &&
        match[1] !== "if" &&
        match[1] !== "for" &&
        match[1] !== "while"
      ) {
        const methodName = match[1]

        // Skip if it's not a valid method name
        if (["return", "throw", "new", "delete", "typeof"].includes(methodName)) {
          continue
        }

        // Find end of method
        let braceCount = 0
        let endLine = i
        let started = false

        for (let j = i; j < lines.length - 1; j++) {
          const l = lines[j]
          for (const char of l) {
            if (char === "{") {
              braceCount++
              started = true
            } else if (char === "}") {
              braceCount--
            }
          }
          if (started && braceCount === 0) {
            endLine = j
            break
          }
        }

        // Check for JSDoc comment above method
        let docstring: string | undefined
        if (i > 1 && lines[i - 1].trim().endsWith("*/")) {
          let docStart = i - 1
          while (docStart > 0 && !lines[docStart].includes("/**")) {
            docStart--
          }
          docstring = lines.slice(docStart, i).join("\n")
        }

        methods.push({
          name: methodName,
          startLine: classStartLine + i + 1,
          endLine: classStartLine + endLine + 1,
          signature: line.trim(),
          docstring,
        })

        break // Found a match, move to next line
      }
    }
  }

  return methods
}

/**
 * Extract classes from Python
 */
function extractPythonClasses(content: string): CodeClass[] {
  const classes: CodeClass[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(/^class\s+(\w+)(?:\([^)]*\))?:/)

    if (match) {
      const className = match[1]
      const startLine = i
      const indent = line.search(/\S/)

      // Find end of class (by indentation)
      let endLine = i
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === "") continue
        const currentIndent = l.search(/\S/)
        if (currentIndent <= indent && l.trim() !== "") {
          endLine = j - 1
          break
        }
        endLine = j
      }

      // Extract methods within class
      const classLines = lines.slice(startLine, endLine + 1)
      const methods = extractPythonClassMethods(classLines, startLine)

      // Check for docstring
      let docstring: string | undefined
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim()
        if (nextLine.startsWith('"""') || nextLine.startsWith("'''")) {
          const quote = nextLine.slice(0, 3)
          let docEnd = i + 1
          if (!nextLine.slice(3).includes(quote)) {
            for (let j = i + 2; j < lines.length; j++) {
              if (lines[j].includes(quote)) {
                docEnd = j
                break
              }
            }
          }
          docstring = lines.slice(i + 1, docEnd + 1).join("\n")
        }
      }

      classes.push({
        name: className,
        startLine: startLine + 1,
        endLine: endLine + 1,
        methods,
        docstring,
      })
    }
  }

  return classes
}

/**
 * Extract methods from a Python class
 */
function extractPythonClassMethods(classLines: string[], classStartLine: number): CodeFunction[] {
  const methods: CodeFunction[] = []

  for (let i = 1; i < classLines.length; i++) {
    const line = classLines[i]
    const match = line.match(/^\s+(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/)

    if (match) {
      const methodName = match[1]
      const startLine = i
      const indent = line.search(/\S/)

      // Find end of method
      let endLine = i
      for (let j = i + 1; j < classLines.length; j++) {
        const l = classLines[j]
        if (l.trim() === "") continue
        const currentIndent = l.search(/\S/)
        if (currentIndent <= indent && l.trim() !== "") {
          endLine = j - 1
          break
        }
        endLine = j
      }

      // Check for docstring
      let docstring: string | undefined
      if (i + 1 < classLines.length) {
        const nextLine = classLines[i + 1].trim()
        if (nextLine.startsWith('"""') || nextLine.startsWith("'''")) {
          const quote = nextLine.slice(0, 3)
          let docEnd = i + 1
          if (!nextLine.slice(3).includes(quote)) {
            for (let j = i + 2; j < classLines.length; j++) {
              if (classLines[j].includes(quote)) {
                docEnd = j
                break
              }
            }
          }
          docstring = classLines.slice(i + 1, docEnd + 1).join("\n")
        }
      }

      methods.push({
        name: methodName,
        startLine: classStartLine + startLine + 1,
        endLine: classStartLine + endLine + 1,
        signature: line.trim(),
        docstring,
      })
    }
  }

  return methods
}

/**
 * Parse code content
 */
export function parseCode(content: string, filename: string): CodeParseResult {
  const language = detectLanguage(filename)

  let imports: CodeImport[] = []
  let functions: CodeFunction[] = []
  let classes: CodeClass[] = []

  if (["javascript", "typescript"].includes(language)) {
    imports = extractJSImports(content)
    functions = extractJSFunctions(content)
    classes = extractJSClasses(content)
  } else if (language === "python") {
    imports = extractPythonImports(content)
    functions = extractPythonFunctions(content)
    classes = extractPythonClasses(content)
  }

  const comments = extractComments(content, language)

  return {
    language,
    imports,
    functions,
    classes,
    comments,
    content,
  }
}

/**
 * Extract text content suitable for embedding
 */
export function extractCodeEmbeddableContent(content: string, filename: string): string {
  const result = parseCode(content, filename)

  const parts: string[] = []

  // Add comments
  if (result.comments.length > 0) {
    parts.push(result.comments.join("\n"))
  }

  // Add function signatures and docstrings
  for (const func of result.functions) {
    parts.push(func.signature)
    if (func.docstring) {
      parts.push(func.docstring)
    }
  }

  return parts.join("\n\n")
}
