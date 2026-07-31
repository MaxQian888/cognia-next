import type { ComponentSpec } from "../../types.js"
import type { FrameworkCodeGenOptions, GeneratedComponent } from "../../types.js"
import type { StateVariable, EventBinding, MethodSpec } from "../../types.js"
import { BaseFrameworkGenerator } from "./base-generator.js"
import { frameworkRules, templateRules } from "./framework-rules.js"

/**
 * React Component Generator
 * Generates React functional components with hooks
 */
export class ReactGenerator extends BaseFrameworkGenerator {
  constructor() {
    super("react")
  }

  generate(spec: ComponentSpec, options: FrameworkCodeGenOptions): GeneratedComponent {
    const componentName = this.pascalCase(spec.name)
    const isTypeScript = options.typescript ?? true

    // 1. Generate imports
    const imports = this.collectImports(spec, options)
    const importStatements = this.generateImports(imports, options)

    // 2. Generate props interface
    const propsInterface = this.generatePropsInterface(componentName)

    // 3. Transform template
    const jsx = this.mapTemplate(spec.template, spec.logic, options)

    // 4. Generate state hooks and methods
    const stateHooks = this.mapState(spec.logic?.state || [], options)
    const methods = this.extractMethods(spec.logic)
    const styles = this.generateStyleImport(spec, options)

    // 5. Assemble complete component
    const code = `${importStatements}
${propsInterface}

export default function ${componentName}() {
${stateHooks ? `  ${stateHooks}\n` : ""}
${methods ? `  ${methods}\n` : ""}
  return (
    <>${jsx}</>
  )
}
${styles ? `\n${styles}` : ""}`

    return {
      name: componentName,
      code,
      language: isTypeScript ? "tsx" : "jsx",
      imports: importStatements.split("\n").filter((l) => l.trim().startsWith("import")),
      dependencies: this.resolveDependencies(spec, options),
      metadata: this.buildMetadata(spec),
    }
  }

  private generateImports(imports: string[], _options: FrameworkCodeGenOptions): string {
    const reactImports = new Set<string>()

    if (imports.some((i) => i.includes("useState"))) {
      reactImports.add("useState")
    }
    if (imports.some((i) => i.includes("useEffect"))) {
      reactImports.add("useEffect")
    }

    let importStr = ""

    // Always import React for JSX
    importStr += `import React from 'react'\n`

    // React hooks imports
    if (reactImports.size > 0) {
      importStr += `import { ${Array.from(reactImports).join(", ")} } from 'react'\n`
    }

    // Styles
    if (imports.some((i) => i.includes("styles"))) {
      importStr += `import styles from './styles.module.css'\n`
    }

    return importStr.trim()
  }

  private generatePropsInterface(componentName: string): string {
    return `interface ${componentName}Props {
  // TODO: Define component props
}
`
  }

  private generateStyleImport(spec: ComponentSpec, options: FrameworkCodeGenOptions): string {
    if (!spec.styles || spec.styles.trim() === "") {
      return ""
    }

    if (options.cssModules) {
      // Placeholder for CSS Modules import
      return `// Import from ${this.camelCase(spec.name)}.module.css`
    }

    // Inline styles comment with proper format
    const cssLines = spec.styles.split("\n").slice(0, 3)
    return `/* CSS Rules:\n${cssLines.map((line) => ` * ${line}`).join("\n")}\n */`
  }

  protected mapState(state: StateVariable[], options: FrameworkCodeGenOptions): string {
    if (state.length === 0) {
      return ""
    }

    return state
      .map((s) => {
        const setter = `set${this.pascalCase(s.name)}`
        const type = options.typescript ? `<${s.type}>` : ""
        return `const [${s.name}, ${setter}] = useState${type}(${JSON.stringify(s.initial)})`
      })
      .join("\n  ")
  }

  protected mapEvents(events: EventBinding[], _options: FrameworkCodeGenOptions): string {
    return this.generateEventHandlerStubs(events)
  }

  protected mapTemplate(html: string, _logic: unknown, _options: FrameworkCodeGenOptions): string {
    let jsx = html

    // Step 1: Replace data-binding with JSX interpolation
    // data-binding="count" -> {count}
    jsx = jsx.replace(/data-binding="([^"]+)"/g, (_match, variable) =>
      frameworkRules.react.templateBinding(variable)
    )

    // Step 2: Replace data-event with React event handler
    // data-event="click:increment" -> onClick={increment}
    jsx = jsx.replace(/data-event="([^:]+):([^"]+)"/g, (_match, event, handler) =>
      frameworkRules.react.eventBinding(event, handler)
    )

    // Step 3: Replace data-condition with JSX conditional
    // data-condition="count > 0" -> {count > 0 && ...}
    jsx = jsx.replace(/data-condition="([^"]+)"/g, (_match, condition) =>
      frameworkRules.react.conditionalBinding(condition)
    )

    // Step 4: Convert HTML to JSX
    jsx = templateRules.htmlToJsx(jsx)

    // Step 5: Fix self-closing tags
    jsx = templateRules.fixSelfClosing(jsx)

    // Step 6: Clean up remaining data-* attributes
    jsx = templateRules.cleanAttributes(jsx)

    // Step 7: Wrap in root div if needed
    if (!jsx.trim().startsWith("<")) {
      jsx = `<div>${jsx}</div>`
    }

    return jsx.trim()
  }

  protected mapStyles(css: string, options: FrameworkCodeGenOptions): string {
    return super.mapStyles(css, options)
  }

  protected collectImports(spec: ComponentSpec, _options: FrameworkCodeGenOptions): string[] {
    const imports = new Set<string>(["React"])

    // Need useState for state
    if (spec.logic?.state && spec.logic.state.length > 0) {
      imports.add("useState")
    }

    // Only add useCallback if actually using memoized callbacks
    // For now, we generate simple inline handlers, so this is not needed
    // if (spec.logic?.events && spec.logic.events.length > 0) {
    //   imports.add('useCallback');
    // }

    // Need useEffect for lifecycle
    if (spec.logic?.methods?.some((m: MethodSpec) => m.kind === "lifecycle")) {
      imports.add("useEffect")
    }

    // Need useMemo for complex computations
    if (
      spec.logic?.methods?.some(
        (m: { code?: string; kind?: string }) =>
          m.code?.includes("computed") || m.code?.includes("useMemo")
      )
    ) {
      imports.add("useMemo")
    }

    // Style imports
    if (spec.styles) {
      imports.add("styles")
    }

    return Array.from(imports)
  }
}
