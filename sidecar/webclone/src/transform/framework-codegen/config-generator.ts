import type { FrameworkCodeGenOptions as _FrameworkCodeGenOptions } from "../../types.js"

/**
 * Generates build and runtime configuration files for project scaffolds
 */
export class ConfigGenerator {
  /**
   * Generate index.html entry point for browser
   */
  static generateIndexHtml(framework: string, typescript: boolean = true): string {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${framework.charAt(0).toUpperCase() + framework.slice(1)} App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/${this.getMainFile(framework, typescript)}"></script>
  </body>
</html>
`
  }

  /**
   * Generate vite.config.ts for all frameworks
   */
  static generateViteConfig(framework: string): string {
    const pluginImports = this.getVitePlugins(framework)
    const pluginConfig = this.getVitePluginConfig(framework)

    return `import { defineConfig } from 'vite'
${pluginImports}

export default defineConfig({
  plugins: [${pluginConfig}],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
`
  }

  /**
   * Generate tsconfig.json for TypeScript projects
   */
  static generateTsConfig(framework: string): string {
    const compilerOptions = this.getTsCompilerOptions(framework)

    return JSON.stringify(
      {
        compilerOptions,
        include: ["src"],
        references: [{ path: "./tsconfig.app.json" }],
      },
      null,
      2
    )
  }

  /**
   * Generate tsconfig.app.json (app-specific TS config)
   */
  static generateTsAppConfig(_framework: string): string {
    return JSON.stringify(
      {
        compilerOptions: {
          composite: true,
          skipLibCheck: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
        include: ["src"],
      },
      null,
      2
    )
  }

  /**
   * Generate .env.example template
   */
  static generateEnvExample(): string {
    return `# API Configuration
# VITE_API_BASE=https://api.example.com

# Feature Flags
# VITE_ENABLE_ANALYTICS=true

# Environment
VITE_ENV=development
`
  }

  /**
   * Get the main entry file name for a framework
   */
  private static getMainFile(framework: string, typescript: boolean): string {
    const ext = typescript ? "ts" : "js"

    if (framework === "vue") {
      return `src/main.${ext}`
    } else if (framework === "react") {
      return `src/main.${typescript ? "tsx" : "jsx"}`
    } else if (framework === "angular") {
      return `src/main.ts`
    } else if (framework === "svelte") {
      return `src/main.ts`
    } else if (framework === "jquery") {
      return `src/main.${ext}`
    }
    return `src/main.${ext}`
  }

  /**
   * Get Vite plugin imports for each framework
   */
  private static getVitePlugins(framework: string): string {
    switch (framework) {
      case "vue":
        return "import vue from '@vitejs/plugin-vue'"
      case "react":
        return "import react from '@vitejs/plugin-react'"
      case "svelte":
        return "import svelte from '@sveltejs/vite-plugin-svelte'"
      case "angular":
      case "jquery":
        return "// No special Vite plugins needed"
      default:
        return "// No special Vite plugins needed"
    }
  }

  /**
   * Get Vite plugin configuration for each framework
   */
  private static getVitePluginConfig(framework: string): string {
    switch (framework) {
      case "vue":
        return "vue()"
      case "react":
        return "react()"
      case "svelte":
        return "svelte()"
      case "angular":
      case "jquery":
        return ""
      default:
        return ""
    }
  }

  /**
   * Get TypeScript compiler options for each framework
   */
  private static getTsCompilerOptions(framework: string): Record<string, unknown> {
    const baseOptions = {
      target: "ES2020",
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: true,
      noImplicitAny: true,
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      sourceMap: true,
      declaration: true,
      declarationMap: true,
    }

    switch (framework) {
      case "vue":
        return {
          ...baseOptions,
          types: ["vite/client"],
          jsx: "preserve",
        }
      case "react":
        return {
          ...baseOptions,
          types: ["vite/client", "react", "react-dom"],
          jsx: "react-jsx",
        }
      case "angular":
        return {
          ...baseOptions,
          types: ["@angular/core"],
          experimentalDecorators: true,
          useDefineForClassFields: false,
        }
      case "svelte":
        return {
          ...baseOptions,
          types: ["vite/client", "svelte"],
        }
      case "jquery":
        return {
          ...baseOptions,
          types: ["jquery"],
        }
      default:
        return baseOptions
    }
  }
}
