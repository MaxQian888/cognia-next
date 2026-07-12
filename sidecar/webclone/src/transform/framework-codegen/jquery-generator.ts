import { BaseFrameworkGenerator } from "./base-generator.js"
import type { ComponentSpec, FrameworkCodeGenOptions, GeneratedComponent } from "../../types.js"
import type { StateVariable, EventBinding } from "../../types.js"
import { frameworkRules, templateRules } from "./framework-rules.js"

/**
 * jQuery component code generator
 * Generates jQuery-based component class with DOM manipulation
 */
export class JQueryGenerator extends BaseFrameworkGenerator {
  constructor() {
    super("jquery")
  }

  generate(spec: ComponentSpec, options: FrameworkCodeGenOptions): GeneratedComponent {
    const componentName = this.pascalCase(spec.name)
    const stateDeclarations = this.mapState(spec.logic?.state || [], options)
    const eventSetup = this.mapEvents(spec.logic?.events || [], options)
    const imports = this.collectImports(spec, options)
    const cssGuidance = spec.styles ? this.mapStyles(spec.styles, options) : ""

    const code = `${imports.join("\n")}

export class ${componentName} {
  private $root: JQuery;
${stateDeclarations}

  constructor(selector: string) {
    this.$root = $(selector);
    this.init();
  }

  private init(): void {
    this.setupEventListeners();
    this.render();
  }

  private setupEventListeners(): void {
${eventSetup}
  }

  private render(): void {
    // TODO: Implement render() to update DOM based on state
    this.updateContent();
  }

  private updateContent(): void {
    // TODO: Update component content with current state
  }
}
${cssGuidance ? "\n" + cssGuidance : ""}`

    return {
      name: spec.name,
      code,
      language: options.typescript ? "ts" : "js",
      imports,
      dependencies: this.resolveDependencies(spec, options),
      metadata: this.buildMetadata(spec),
    }
  }

  protected mapState(state: StateVariable[], _options: FrameworkCodeGenOptions): string {
    if (state.length === 0) {
      return ""
    }

    return state
      .map((s) => "  " + frameworkRules.jquery.stateDeclaration(s.name, s.type, s.initial))
      .join("\n")
  }

  protected mapEvents(events: EventBinding[], _options: FrameworkCodeGenOptions): string {
    if (events.length === 0) {
      return "    // No event listeners configured"
    }

    return events
      .map((e) => `    this.$root.on('${e.event}', () => this.${e.handler}());`)
      .join("\n")
  }

  protected mapTemplate(html: string, _logic: unknown, _options: FrameworkCodeGenOptions): string {
    let template = html

    // Step 1: Replace data-binding with data-* attributes for jQuery selectors
    // data-binding="count" -> data-count=""
    template = template.replace(/data-binding="([^"]*)"/g, (_, variable) => `data-${variable}=""`)

    // Step 2: Clean up remaining data-event and data-condition attributes
    template = templateRules.cleanAttributes(template)

    return template
  }

  protected mapStyles(css: string, _options: FrameworkCodeGenOptions): string {
    if (!css) {
      return ""
    }
    return `
/* CSS (include via <link> tag or use inline styles) */
${css}`
  }

  protected collectImports(spec: ComponentSpec, options: FrameworkCodeGenOptions): string[] {
    const imports = ["import $ from 'jquery';"]

    if (options.typescript) {
      imports.push("import type { JQuery } from 'jquery';")
    }

    return imports
  }
}
