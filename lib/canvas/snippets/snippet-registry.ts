/**
 * Snippet Registry - Code snippets for quick insertion in Canvas
 */

import { loggers } from "@cognia/logging"

export interface CodeSnippet {
  id: string
  prefix: string
  description: string
  body: string | string[]
  language: string
  category?: string
  isUserDefined?: boolean
}

export interface SnippetVariable {
  name: string
  defaultValue?: string
  description?: string
}

const JAVASCRIPT_SNIPPETS: CodeSnippet[] = [
  {
    id: "js-function",
    prefix: "fn",
    description: "Function declaration",
    body: ["function ${1:name}(${2:params}) {", "  ${0}", "}"],
    language: "javascript",
    category: "functions",
  },
  {
    id: "js-arrow",
    prefix: "af",
    description: "Arrow function",
    body: "const ${1:name} = (${2:params}) => ${0}",
    language: "javascript",
    category: "functions",
  },
  {
    id: "js-async-function",
    prefix: "afn",
    description: "Async function",
    body: ["async function ${1:name}(${2:params}) {", "  ${0}", "}"],
    language: "javascript",
    category: "functions",
  },
  {
    id: "js-try-catch",
    prefix: "try",
    description: "Try-catch block",
    body: ["try {", "  ${1}", "} catch (${2:error}) {", "  ${0}", "}"],
    language: "javascript",
    category: "control",
  },
  {
    id: "js-for-of",
    prefix: "forof",
    description: "For...of loop",
    body: ["for (const ${1:item} of ${2:array}) {", "  ${0}", "}"],
    language: "javascript",
    category: "loops",
  },
  {
    id: "js-import",
    prefix: "imp",
    description: "Import statement",
    body: "import { ${1:module} } from '${2:path}'",
    language: "javascript",
    category: "imports",
  },
  {
    id: "js-export-default",
    prefix: "expd",
    description: "Export default",
    body: "export default ${1:name}",
    language: "javascript",
    category: "exports",
  },
  {
    id: "js-console-log",
    prefix: "cl",
    description: "Console log",
    body: "console.log(${1:message})",
    language: "javascript",
    category: "debug",
  },
]

const TYPESCRIPT_SNIPPETS: CodeSnippet[] = [
  ...JAVASCRIPT_SNIPPETS.map((s) => ({ ...s, language: "typescript" })),
  {
    id: "ts-interface",
    prefix: "int",
    description: "Interface declaration",
    body: ["interface ${1:Name} {", "  ${0}", "}"],
    language: "typescript",
    category: "types",
  },
  {
    id: "ts-type",
    prefix: "type",
    description: "Type alias",
    body: "type ${1:Name} = ${0}",
    language: "typescript",
    category: "types",
  },
  {
    id: "ts-enum",
    prefix: "enum",
    description: "Enum declaration",
    body: ["enum ${1:Name} {", "  ${0}", "}"],
    language: "typescript",
    category: "types",
  },
  {
    id: "ts-generic-function",
    prefix: "gfn",
    description: "Generic function",
    body: ["function ${1:name}<${2:T}>(${3:param}: ${2:T}): ${4:ReturnType} {", "  ${0}", "}"],
    language: "typescript",
    category: "functions",
  },
]

const REACT_SNIPPETS: CodeSnippet[] = [
  {
    id: "react-fc",
    prefix: "rfc",
    description: "React functional component",
    body: [
      "export function ${1:ComponentName}({ ${2:props} }: ${1:ComponentName}Props) {",
      "  return (",
      "    <div>",
      "      ${0}",
      "    </div>",
      "  );",
      "}",
    ],
    language: "typescript",
    category: "react",
  },
  {
    id: "react-use-state",
    prefix: "us",
    description: "useState hook",
    body: "const [${1:state}, set${1/(.*)/${1:/capitalize}/}] = useState(${2:initialValue})",
    language: "typescript",
    category: "react-hooks",
  },
  {
    id: "react-use-effect",
    prefix: "ue",
    description: "useEffect hook",
    body: ["useEffect(() => {", "  ${1}", "  return () => {", "    ${2}", "  };", "}, [${0}]);"],
    language: "typescript",
    category: "react-hooks",
  },
  {
    id: "react-use-callback",
    prefix: "ucb",
    description: "useCallback hook",
    body: ["const ${1:callback} = useCallback(() => {", "  ${0}", "}, []);"],
    language: "typescript",
    category: "react-hooks",
  },
  {
    id: "react-use-memo",
    prefix: "um",
    description: "useMemo hook",
    body: "const ${1:memoized} = useMemo(() => ${0}, []);",
    language: "typescript",
    category: "react-hooks",
  },
  {
    id: "react-use-ref",
    prefix: "ur",
    description: "useRef hook",
    body: "const ${1:ref} = useRef<${2:HTMLDivElement}>(null)",
    language: "typescript",
    category: "react-hooks",
  },
]

const PYTHON_SNIPPETS: CodeSnippet[] = [
  {
    id: "py-def",
    prefix: "def",
    description: "Function definition",
    body: ["def ${1:name}(${2:params}):", "    ${0}"],
    language: "python",
    category: "functions",
  },
  {
    id: "py-async-def",
    prefix: "adef",
    description: "Async function definition",
    body: ["async def ${1:name}(${2:params}):", "    ${0}"],
    language: "python",
    category: "functions",
  },
  {
    id: "py-class",
    prefix: "class",
    description: "Class definition",
    body: ["class ${1:ClassName}:", "    def __init__(self${2:, params}):", "        ${0}"],
    language: "python",
    category: "classes",
  },
  {
    id: "py-try-except",
    prefix: "try",
    description: "Try-except block",
    body: ["try:", "    ${1}", "except ${2:Exception} as ${3:e}:", "    ${0}"],
    language: "python",
    category: "control",
  },
  {
    id: "py-for",
    prefix: "for",
    description: "For loop",
    body: ["for ${1:item} in ${2:iterable}:", "    ${0}"],
    language: "python",
    category: "loops",
  },
  {
    id: "py-if-main",
    prefix: "ifmain",
    description: "If main block",
    body: ['if __name__ == "__main__":', "    ${0}"],
    language: "python",
    category: "control",
  },
  {
    id: "py-list-comp",
    prefix: "lc",
    description: "List comprehension",
    body: "[${1:expr} for ${2:item} in ${3:iterable}]",
    language: "python",
    category: "expressions",
  },
]

export const SNIPPET_REGISTRY: Record<string, CodeSnippet[]> = {
  javascript: JAVASCRIPT_SNIPPETS,
  typescript: [...TYPESCRIPT_SNIPPETS, ...REACT_SNIPPETS],
  jsx: [...JAVASCRIPT_SNIPPETS, ...REACT_SNIPPETS.map((s) => ({ ...s, language: "jsx" }))],
  tsx: [...TYPESCRIPT_SNIPPETS, ...REACT_SNIPPETS],
  python: PYTHON_SNIPPETS,
}

export class SnippetProvider {
  private customSnippets: Map<string, CodeSnippet[]> = new Map()

  getSnippets(language: string): CodeSnippet[] {
    const builtIn = SNIPPET_REGISTRY[language] || []
    const custom = this.customSnippets.get(language) || []
    return [...builtIn, ...custom]
  }

  getSnippetsByCategory(language: string, category: string): CodeSnippet[] {
    return this.getSnippets(language).filter((s) => s.category === category)
  }

  getCategories(language: string): string[] {
    const snippets = this.getSnippets(language)
    const categories = new Set(snippets.map((s) => s.category).filter(Boolean))
    return Array.from(categories) as string[]
  }

  registerSnippet(snippet: CodeSnippet): void {
    const language = snippet.language
    const existing = this.customSnippets.get(language) || []
    const filtered = existing.filter((s) => s.id !== snippet.id)
    this.customSnippets.set(language, [...filtered, { ...snippet, isUserDefined: true }])
  }

  unregisterSnippet(language: string, snippetId: string): void {
    const existing = this.customSnippets.get(language) || []
    this.customSnippets.set(
      language,
      existing.filter((s) => s.id !== snippetId)
    )
  }

  findSnippetByPrefix(language: string, prefix: string): CodeSnippet | undefined {
    return this.getSnippets(language).find((s) => s.prefix === prefix)
  }

  searchSnippets(language: string, query: string): CodeSnippet[] {
    const lowerQuery = query.toLowerCase()
    return this.getSnippets(language).filter(
      (s) =>
        s.prefix.toLowerCase().includes(lowerQuery) ||
        s.description.toLowerCase().includes(lowerQuery)
    )
  }

  applySnippet(snippet: CodeSnippet): string {
    const body = Array.isArray(snippet.body) ? snippet.body.join("\n") : snippet.body
    return body.replace(/\$\{(\d+)(?::([^}]+))?\}/g, "$2").replace(/\$\d+/g, "")
  }

  exportCustomSnippets(): string {
    const custom: Record<string, CodeSnippet[]> = {}
    for (const [lang, snippets] of this.customSnippets.entries()) {
      custom[lang] = snippets
    }
    return JSON.stringify(custom, null, 2)
  }

  importCustomSnippets(json: string): boolean {
    try {
      const parsed = JSON.parse(json)
      for (const [lang, snippets] of Object.entries(parsed)) {
        if (Array.isArray(snippets)) {
          this.customSnippets.set(lang, snippets as CodeSnippet[])
        }
      }
      return true
    } catch (err) {
      loggers.canvas.warn("snippet import parse failed", {
        error: String(err),
        preview: json.slice(0, 200),
      })
      return false
    }
  }
}

export const snippetProvider = new SnippetProvider()

export default SnippetProvider
