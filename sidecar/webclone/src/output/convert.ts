import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotOptions, ConvertResult, ComponentSpec } from "../types.js"
import { codeGenerator } from "../transform/framework-codegen/index.js"
import { ConfigGenerator } from "../transform/framework-codegen/config-generator.js"
import { SharedLogicExtractor } from "../transform/framework-codegen/shared-logic-extractor.js"

interface LowConfidenceComponent {
  name: string
  confidence: number
  type: string
  reason: string
}

interface FrameworkCodegenOptions {
  framework: string
  typescript?: boolean
  generateDrafts?: boolean
  [key: string]: unknown
}

interface GlobalIndex {
  globalStyles?: Record<string, string>
  globalRules?: string[]
  [key: string]: unknown
}

export function assembleConvert(result: ConvertResult, options: SnapshotOptions): ConvertResult {
  const outputDir = options.output

  try {
    mkdirSync(outputDir, { recursive: true })

    // Write components
    const componentDir = join(outputDir, "components")
    mkdirSync(componentDir, { recursive: true })

    // Collect low-confidence components for review
    const lowConfidenceComponents: LowConfidenceComponent[] = []

    result.components.forEach((comp) => {
      // Sanitize component name: reject path traversal characters
      const safeName = comp.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const compDir = join(componentDir, safeName)
      mkdirSync(compDir, { recursive: true })

      writeFileSync(join(compDir, "template.html"), comp.template)
      writeFileSync(join(compDir, "style.css"), comp.styles || "")

      if (comp.logic?.state || comp.logic?.methods) {
        const logicContent = JSON.stringify(comp.logic, null, 2)
        writeFileSync(join(compDir, "logic.original.json"), logicContent)
      }

      writeFileSync(join(compDir, "manifest.json"), JSON.stringify(comp.manifest, null, 2))

      // Track low-confidence matches
      if ((comp.matchConfidence ?? 0) < 0.6) {
        lowConfidenceComponents.push({
          name: safeName,
          confidence: Math.round((comp.matchConfidence ?? 0) * 100),
          type: comp.type,
          reason:
            (comp.matchConfidence ?? 0) < 0.3
              ? "Very low confidence - strong manual review recommended"
              : "Low confidence - manual review suggested",
        })
      }

      // NEW: Generate framework code if specified
      if (options.frameworkCodegen?.framework) {
        const generated = codeGenerator.generateComponent(comp, options.frameworkCodegen)
        if (generated) {
          const filename = `${generated.name}${generated.language === "vue" ? ".vue" : generated.language === "tsx" ? ".tsx" : ".jsx"}`
          writeFileSync(join(compDir, filename), generated.code)
        }
      }
    })

    // Write global styles if available
    writeGlobalStyles(result, outputDir)

    // Write global files
    writeFileSync(join(outputDir, "index.json"), JSON.stringify(result.index, null, 2))
    writeFileSync(join(outputDir, "README.md"), generateReadme(result))
    writeFileSync(join(outputDir, "MIGRATION.md"), generateMigrationGuide(result))

    // Write low-confidence report if needed
    if (lowConfidenceComponents.length > 0) {
      writeFileSync(
        join(outputDir, "REVIEW_REQUIRED.md"),
        generateReviewReport(lowConfidenceComponents)
      )
    }

    // Generate application template if requested
    if (options.frameworkCodegen?.framework && options.frameworkCodegen?.generateDrafts) {
      writeApplicationDrafts(result, outputDir, options.frameworkCodegen as FrameworkCodegenOptions)
    }

    console.log(`\n  ✓ Conversion complete`)
    console.log(`    Components: ${result.components.size}`)
    const stats = result.index?.stats as { stateful?: number; presentational?: number } | undefined
    if (stats) {
      console.log(`    Stateful:   ${stats.stateful}`)
      console.log(`    Presentational: ${stats.presentational}`)
    }
    if (lowConfidenceComponents.length > 0) {
      console.log(
        `    ⚠️  Low confidence: ${lowConfidenceComponents.length} (see REVIEW_REQUIRED.md)`
      )
    }
    if (options.frameworkCodegen?.framework) {
      console.log(`    📦 Framework: ${options.frameworkCodegen.framework}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Failed to write output: ${message}`)
    throw err
  }

  return result
}

function writeGlobalStyles(result: ConvertResult, outputDir: string): void {
  const stylesDir = join(outputDir, "styles")
  const index = result.index as GlobalIndex | undefined

  // Only create styles directory if we have style-related info
  if (!index?.globalStyles && (!index?.globalRules || index.globalRules.length === 0)) {
    return
  }

  mkdirSync(stylesDir, { recursive: true })

  // Generate variables.css from CSS variables
  if (index?.globalStyles && Object.keys(index.globalStyles).length > 0) {
    const cssVariables = Object.entries(index.globalStyles)
      .map(([key, value]) => `  ${key}: ${value};`)
      .join("\n")

    const variablesContent = `:root {\n${cssVariables}\n}\n`
    writeFileSync(join(stylesDir, "variables.css"), variablesContent)
  }

  // Write reset.css placeholder
  const resetContent = `/* Global CSS Reset */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
`
  writeFileSync(join(stylesDir, "reset.css"), resetContent)

  // Write global.css with collected global rules
  if (index?.globalRules && Array.isArray(index.globalRules) && index.globalRules.length > 0) {
    const globalContent = index.globalRules.join("\n\n")
    writeFileSync(join(stylesDir, "global.css"), globalContent)
  }
}

/**
 * NEW: Write application template drafts
 */
function writeApplicationDrafts(
  result: ConvertResult,
  outputDir: string,
  frameworkOptions: FrameworkCodegenOptions
): void {
  const components = Array.from(result.components.values())
  if (components.length === 0) return

  const draftsDir = join(outputDir, "__drafts__")
  const framework = frameworkOptions.framework
  const frameworkDir = join(draftsDir, framework)

  mkdirSync(frameworkDir, { recursive: true })
  mkdirSync(join(frameworkDir, "src"), { recursive: true })
  mkdirSync(join(frameworkDir, "src", "shared"), { recursive: true })

  // 1. Generate index.html (CRITICAL - entry point for browser)
  const indexHtml = ConfigGenerator.generateIndexHtml(framework, frameworkOptions.typescript)
  writeFileSync(join(frameworkDir, "index.html"), indexHtml)

  // 2. Generate vite.config.ts
  const viteConfig = ConfigGenerator.generateViteConfig(framework)
  writeFileSync(join(frameworkDir, "vite.config.ts"), viteConfig)

  // 3. Generate tsconfig.json
  const tsConfig = ConfigGenerator.generateTsConfig(framework)
  writeFileSync(join(frameworkDir, "tsconfig.json"), tsConfig)

  // 4. Generate tsconfig.app.json (app-specific TS config)
  const tsAppConfig = ConfigGenerator.generateTsAppConfig(framework)
  writeFileSync(join(frameworkDir, "tsconfig.app.json"), tsAppConfig)

  // 5. Generate .env.example
  const envExample = ConfigGenerator.generateEnvExample()
  writeFileSync(join(frameworkDir, ".env.example"), envExample)

  // 6. Generate shared logic files (only if enabled)
  if (frameworkOptions.extractSharedLogic) {
    writeSharedLogicFiles(frameworkDir, result.components, frameworkOptions)
  }

  // 7. Generate App component/file
  const appTemplate = codeGenerator.generateAppTemplate(
    components.map((c) => ({
      name: c.name,
      code: "",
      language: framework === "vue" ? "vue" : frameworkOptions.typescript ? "tsx" : "jsx",
      imports: [],
      dependencies: [],
      metadata: {
        hasState: false,
        eventCount: 0,
        styleSize: 0,
      },
    })),
    {
      framework: framework as "vue" | "react" | "angular" | "svelte" | "jquery",
      typescript: (frameworkOptions.typescript as boolean) ?? true,
      cssModules: (frameworkOptions.cssModules as boolean) ?? false,
      generateDrafts: (frameworkOptions.generateDrafts as boolean) ?? false,
      extractSharedLogic: (frameworkOptions.extractSharedLogic as boolean) ?? false,
    }
  )

  if (framework === "vue") {
    writeFileSync(join(frameworkDir, "src", "App.vue"), appTemplate)
  } else {
    const ext = (frameworkOptions.typescript as boolean) ? ".tsx" : ".jsx"
    writeFileSync(join(frameworkDir, "src", `App${ext}`), appTemplate)
  }

  // 8. Generate main entry point
  const mainEntry = codeGenerator.generateMainEntry({
    framework: framework as "vue" | "react" | "angular" | "svelte" | "jquery",
    typescript: frameworkOptions.typescript as boolean | undefined,
  })
  writeFileSync(join(frameworkDir, "src", mainEntry.filename), mainEntry.code)

  // 9. Generate package.json (framework only, no forced dependencies)
  const packageJson = codeGenerator.generatePackageJson(
    "migrated-app",
    {
      framework: framework as "vue" | "react" | "angular" | "svelte" | "jquery",
      typescript: frameworkOptions.typescript as boolean | undefined,
    },
    []
  )
  writeFileSync(join(frameworkDir, "package.json"), JSON.stringify(packageJson, null, 2))

  // 10. Create .gitignore
  const gitignore = `node_modules/
dist/
.env
.env.local
.DS_Store
*.log
*.swp
`
  writeFileSync(join(frameworkDir, ".gitignore"), gitignore)

  const draftsReadme = `# ${framework.toUpperCase()} Application Draft

This is an auto-generated project template for ${framework.toUpperCase()}.

## Quick Start

\`\`\`bash
npm install
npm run dev
\`\`\`

The app will open at \`http://localhost:5173\`.

## Project Structure

\`\`\`
src/
├── App.${framework === "vue" ? "vue" : frameworkOptions.typescript ? "tsx" : "jsx"}    # Root application component
├── main.${frameworkOptions.typescript ? "ts" : "js"}           # Application entry point
├── components/         # Generated components (copy from snapshot)
└── shared/             # Shared utilities, API clients, and constants
    ├── api.${frameworkOptions.typescript ? "ts" : "js"}        # API client methods
    ├── utils.${frameworkOptions.typescript ? "ts" : "js"}      # Utility functions
    └── constants.${frameworkOptions.typescript ? "ts" : "js"}  # Constants and configuration
\`\`\`

## Setup Instructions

1. **Copy Components**
   \`\`\`bash
   cp -r ../components ./src/
   \`\`\`

2. **Install Dependencies**
   \`\`\`bash
   npm install
   \`\`\`

3. **Start Development Server**
   \`\`\`bash
   npm run dev
   \`\`\`

4. **Build for Production**
   \`\`\`bash
   npm run build
   npm run preview
   \`\`\`

## Next Steps

1. Review each component in \`src/components/\` and adjust as needed
2. Implement any TODO markers in component logic
3. Update styles if needed for your design system
4. Configure your API endpoints in \`src/shared/api.${frameworkOptions.typescript ? "ts" : "js"}\`
5. Add utility functions to \`src/shared/utils.${frameworkOptions.typescript ? "ts" : "js"}\`
6. Update constants in \`src/shared/constants.${frameworkOptions.typescript ? "ts" : "js"}\`
7. Run tests and verify functionality
8. Deploy to production

## Available Scripts

- \`npm run dev\` - Start development server (hot reload enabled)
- \`npm run build\` - Build for production
- \`npm run preview\` - Preview production build locally
- \`npm run type-check\` - Check TypeScript types (if applicable)

## Shared Logic

The \`src/shared/\` directory contains auto-generated shared code:

### API Client (\`api.${frameworkOptions.typescript ? "ts" : "js"}\`)
Centralized API communication with error handling and retry logic.

\`\`\`typescript
import { apiClient, fetchUsers } from './shared/api'

const users = await fetchUsers({ page: 1 })
\`\`\`

### Utilities (\`utils.${frameworkOptions.typescript ? "ts" : "js"}\`)
Common utility functions like debounce, throttle, and deep clone.

\`\`\`typescript
import { debounce, deepClone } from './shared/utils'

const handleResize = debounce(() => { /* ... */ }, 300)
\`\`\`

### Constants (\`constants.${frameworkOptions.typescript ? "ts" : "js"}\`)
Application configuration and constants.

\`\`\`typescript
import { API_ENDPOINTS, DEFAULT_TIMEOUT } from './shared/constants'
\`\`\`

## Framework Documentation

- **Vue 3**: https://vuejs.org/guide/
- **React 18**: https://react.dev/
- **Angular 17**: https://angular.io/docs
- **Svelte 4**: https://svelte.dev/docs
- **jQuery 3.7**: https://api.jquery.com/

## Important Notes

- All components are auto-generated from the original HTML/CSS/JavaScript
- Manual implementation of complex logic may be required
- Some patterns may need adjustment for the target framework
- CSS styles may need tuning for visual consistency
- API calls and external integrations need to be configured

## Troubleshooting

### Port already in use
Change the port in \`vite.config.ts\`:
\`\`\`typescript
server: {
  port: 5174,  // Change to different port
}
\`\`\`

### TypeScript errors
Run type checking:
\`\`\`bash
npx tsc --noEmit
\`\`\`

### Styles not loading
Ensure CSS files are imported in components and \`index.html\` has:
\`\`\`html
<div id="app"></div>
\`\`\`

## Support

For component-specific issues, check the generated component manifests:
\`\`\`bash
../components/*/manifest.json  # Migration metadata
\`\`\`

---

Generated by web-clone framework code generator
`
  writeFileSync(join(frameworkDir, "README.md"), draftsReadme)

  console.log(`  📂 Generated ${framework} draft project at ${frameworkDir}`)
  console.log(
    `  ✅ Ready to use: cd ${join("__drafts__", framework)} && npm install && npm run dev`
  )
}

/**
 * Write shared logic files (API, utilities, constants)
 */
function writeSharedLogicFiles(
  frameworkDir: string,
  components: Map<string, ComponentSpec>,
  frameworkOptions: FrameworkCodegenOptions
): void {
  const sharedDir = join(frameworkDir, "src", "shared")
  const specs = Array.from(components.values())
  const ext = frameworkOptions.typescript ? "ts" : "js"

  // Use SharedLogicExtractor to generate actual code from components
  const apiContent = SharedLogicExtractor.extractApiLogic(specs)
  const utilsContent = SharedLogicExtractor.extractUtilities(specs)
  const constantsContent = SharedLogicExtractor.extractConstants(specs)

  // Only write files with meaningful content
  const sharedFiles: [string, string][] = [
    [`api.${ext}`, apiContent],
    [`utils.${ext}`, utilsContent],
    [`constants.${ext}`, constantsContent],
  ]
  for (const [filename, content] of sharedFiles) {
    if (content.trim()) {
      writeFileSync(join(sharedDir, filename), content)
    }
  }
}

function generateReadme(result: ConvertResult): string {
  const components = Array.from(result.components.values())

  return `# Component Structure

Generated from: ${result.sourceUrl}
Generated at: ${result.timestamp}

## Summary

- **Total Components**: ${components.length}
- **Stateful**: ${components.filter((c) => c.type === "stateful").length}
- **Presentational**: ${components.filter((c) => c.type === "presentational").length}

## Components

${components
  .map((c) => {
    return `### ${c.name}

- **Type**: ${c.type}
- **Confidence**: ${Math.round((c.matchConfidence ?? 0) * 100)}%
- **Path**: \`components/${c.name}/\`
- **Files**:
  - \`template.html\` - Component template
  - \`style.css\` - Component styles
  - \`manifest.json\` - Component metadata
${c.logic ? `  - \`logic.original.json\` - Original logic` : ""}

**Estimated Effort**: ${c.manifest.migration.effort}
- Extraction review: ${c.manifest.migration.effortBreakdown.extraction}
- Conversion: ${c.manifest.migration.effortBreakdown.conversion}

${
  c.manifest.migration.suggestions.length > 0
    ? `**Suggestions**:
${c.manifest.migration.suggestions.map((s) => `- ${s}`).join("\n")}`
    : ""
}
`
  })
  .join("\n")}
`
}

function generateMigrationGuide(result: ConvertResult): string {
  const components = Array.from(result.components.values())

  // Sort by recommended migration order: high confidence + simple first
  const sortedByRecommendation = components.sort((a, b) => {
    const aConfidence = a.matchConfidence ?? 0
    const bConfidence = b.matchConfidence ?? 0

    // Prioritize high-confidence components
    if (aConfidence >= 0.8 && bConfidence < 0.8) return -1
    if (aConfidence < 0.8 && bConfidence >= 0.8) return 1

    // Within similar confidence, prefer simpler components (shorter effort)
    const effortOrder = { "0.5h": 1, "1h": 2, "2h": 3, "4h": 4, "8h+": 5 }
    const aEffortRank = effortOrder[a.manifest.migration.effort as keyof typeof effortOrder] ?? 5
    const bEffortRank = effortOrder[b.manifest.migration.effort as keyof typeof effortOrder] ?? 5
    return aEffortRank - bEffortRank
  })

  const highConfidenceSimple = sortedByRecommendation.filter(
    (c) => (c.matchConfidence ?? 0) >= 0.8 && c.manifest.migration.effort === "0.5h"
  )
  const highConfidenceModerate = sortedByRecommendation.filter(
    (c) => (c.matchConfidence ?? 0) >= 0.8 && ["1h", "2h"].includes(c.manifest.migration.effort)
  )
  const highConfidenceComplex = sortedByRecommendation.filter(
    (c) => (c.matchConfidence ?? 0) >= 0.8 && ["4h", "8h+"].includes(c.manifest.migration.effort)
  )
  const lowConfidence = sortedByRecommendation.filter((c) => (c.matchConfidence ?? 0) < 0.8)

  return `# Migration Guide

## Overview

This guide helps you migrate components in an optimal order. Components with higher confidence should be migrated first, as their extraction is more reliable. Lower-confidence components need manual review before migration.

## Recommended Migration Phases

### Phase 1: Quick Wins (High Confidence, Simple)

${
  highConfidenceSimple.length > 0
    ? `Start with these high-confidence, simple components:

${highConfidenceSimple.map((c) => `- **${c.name}** (${Math.round((c.matchConfidence ?? 0) * 100)}%, ${c.manifest.migration.effort})`).join("\n")}`
    : "No high-confidence simple components found."
}

### Phase 2: Core Features (High Confidence, Moderate Complexity)

${
  highConfidenceModerate.length > 0
    ? `Once quick wins are done, migrate these reliable components:

${highConfidenceModerate.map((c) => `- **${c.name}** (${Math.round((c.matchConfidence ?? 0) * 100)}%, ${c.manifest.migration.effort})`).join("\n")}`
    : "No moderate-complexity components found."
}

### Phase 3: Complex Features (High Confidence, Complex)

${
  highConfidenceComplex.length > 0
    ? `These are comprehensive and reliable, but require more effort:

${highConfidenceComplex.map((c) => `- **${c.name}** (${Math.round((c.matchConfidence ?? 0) * 100)}%, ${c.manifest.migration.effort})`).join("\n")}`
    : "No complex high-confidence components found."
}

### Phase 4: Manual Review Required (Low Confidence)

${
  lowConfidence.length > 0
    ? `⚠️  These components need careful review before migration. See REVIEW_REQUIRED.md for details.

${lowConfidence.map((c) => `- **${c.name}** (${Math.round((c.matchConfidence ?? 0) * 100)}% confidence, ${c.manifest.migration.effort})`).join("\n")}`
    : "All components have high confidence!"
}

## Per-Component Instructions

For each component, follow these steps:

1. **Review the manifest**
   \`\`\`
   cat components/{ComponentName}/manifest.json
   \`\`\`

2. **Check the extraction**
   - Template: \`components/{ComponentName}/template.html\`
   - Styles: \`components/{ComponentName}/style.css\`
   - Logic: \`components/{ComponentName}/logic.original.json\` (if available)

3. **Convert to your framework**
   - Follow suggestions in the manifest
   - Convert state variables to reactive references
   - Map event handlers to component methods
   - Integrate styles into your framework

4. **Test and validate**
   - Verify visual appearance
   - Test event handlers and state updates
   - Cross-reference with REVIEW_REQUIRED.md if confidence is low

## Effort Estimation

Each component shows estimated effort:
- **Extraction review**: Time to verify the extracted boundaries and content are correct
- **Conversion**: Time to convert to your target framework

For low-confidence components, add extra time for manual corrections.

## Common Patterns

### Converting State Variables

Extracted state variables are in \`logic.original.json\`. Each has:
- \`type\`: The detected data type
- \`initial\`: Initial value
- \`bindings\`: Where it's used in the template
- \`mutators\`: How it's modified in the logic

### Mapping Event Handlers

Check the \`events\` section in manifest.json. Each event has:
- \`event\`: The event type (click, change, submit, etc.)
- \`handler\`: The handler function name
- \`selector\`: Where the handler is attached

### CSS Migration

Component-specific styles are in \`style.css\`. You may need to:
- Adjust CSS variable references to your framework
- Update class names if migrating from BEM to another convention
- Merge with your global CSS reset

---

**Note**: This migration guide is generated automatically. Review each component's confidence level before starting conversion. Manual verification is essential for optimal results.
`
}

function generateReviewReport(lowConfidenceComponents: LowConfidenceComponent[]): string {
  return `# Components Requiring Manual Review

⚠️ **The following components have low extraction confidence and should be manually verified.**

Generated: ${new Date().toISOString()}

## Summary

- **Total components requiring review**: ${lowConfidenceComponents.length}
- **Very low confidence** (< 30%): ${lowConfidenceComponents.filter((c) => c.confidence < 30).length}
- **Low confidence** (30-60%): ${lowConfidenceComponents.filter((c) => c.confidence >= 30).length}

## Components

${lowConfidenceComponents
  .sort((a, b) => a.confidence - b.confidence)
  .map(
    (comp) => `
### ${comp.name}

- **Confidence**: ${comp.confidence}%
- **Type**: ${comp.type}
- **Reason**: ${comp.reason}
- **Action**: Open \`components/${comp.name}/manifest.json\` and verify:
  - [ ] Component boundaries are correctly identified
  - [ ] Associated styles are accurate
  - [ ] State variables and events are properly extracted
  - [ ] Update template.html if needed
  - [ ] Adjust manifest.json with correct metadata

---
`
  )
  .join("")}

## Recommendations

1. **Sort by confidence**: Start with highest confidence components first
2. **Verify boundaries**: Check if component template contains all necessary HTML
3. **Review styles**: Ensure all CSS rules for the component are included
4. **Cross-reference**: Compare with manifest.json's state/events/suggestions
5. **Manual corrections**: Edit template.html and manifest.json as needed

## How to Proceed

1. Review each component in order (highest confidence first)
2. If a component's boundaries are wrong, edit the \`template.html\`
3. If styles are missing/incorrect, update \`style.css\`
4. Run your migration process after all reviews are complete

---

**Note**: This file is auto-generated. Manual verification is essential for high-quality results.
`
}
