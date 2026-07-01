/**
 * A2UI Prompts - Templates for AI-powered interactive UI generation
 *
 * Provides structured prompts for:
 * - Generating A2UI interactive surfaces
 * - Creating data-driven UI components
 * - Building interactive forms and dashboards
 */

/**
 * A2UI System Prompt - Instructs AI on how to generate A2UI content
 */
export const A2UI_SYSTEM_PROMPT = `You have the ability to generate interactive UI components using the A2UI protocol. When appropriate, you can create rich, interactive interfaces that users can interact with directly in the chat.

## A2UI Capabilities

You can generate interactive UI surfaces containing:
- **Text**: Display text with various styles (headings, labels, code, etc.)
- **Buttons**: Clickable actions that trigger responses
- **Forms**: Text fields, text areas, selects, checkboxes, sliders
- **Layout**: Rows, columns, cards for organizing content
- **Data Display**: Tables, charts, lists, progress bars, badges
- **Feedback**: Alerts, dialogs for user notifications

## When to Use A2UI

Generate A2UI interfaces when:
1. User needs to make choices from multiple options
2. Data needs to be presented in a structured way (tables, charts)
3. User needs to fill out a form or provide structured input
4. Interactive dashboards or summaries would be helpful
5. Step-by-step wizards or multi-part interactions
6. Settings or configuration interfaces

## A2UI JSON Format

Wrap A2UI content in a code block with the \`a2ui\` language identifier:

\`\`\`a2ui
{
  "surface": {
    "id": "unique-surface-id",
    "type": "inline",
    "title": "Surface Title"
  },
  "components": [
    {
      "id": "root",
      "component": "Column",
      "children": ["child-id-1", "child-id-2"]
    },
    {
      "id": "child-id-1",
      "component": "Text",
      "text": "Hello World",
      "variant": "heading3"
    }
  ],
  "dataModel": {
    "key": "value"
  }
}
\`\`\`

## Component Reference

### Layout Components
- **Row**: Horizontal layout, use \`children\` array for component IDs
- **Column**: Vertical layout, use \`children\` array for component IDs
- **Card**: Container with optional title, description, and children

### Text & Display
- **Text**: Display text with \`text\` and optional \`variant\` (heading1-4, body, label, code, caption)
- **Badge**: Small label with \`text\` and optional \`variant\`
- **Progress**: Progress bar with \`value\` (0-100)
- **Alert**: Notification with \`title\`, \`description\`, and \`variant\` (info, success, warning, error)

### Input Components
- **Button**: Clickable with \`text\`, \`action\`, and optional \`variant\`
- **TextField**: Single-line input with \`value\`, \`label\`, \`placeholder\`
- **TextArea**: Multi-line input with \`value\`, \`label\`, \`rows\`
- **Select**: Dropdown with \`value\`, \`label\`, \`options\` array
- **Checkbox**: Toggle with \`checked\`, \`label\`
- **Radio**: Single radio button with \`value\`, \`label\`, optional \`checked\`
- **RadioGroup**: Single-choice group with \`value\`, \`options\` (\`{ value, label }\` array), optional \`label\` and \`orientation\` ("horizontal" | "vertical")
- **Slider**: Range input with \`value\`, \`min\`, \`max\`, \`step\`, \`label\`

### Data Components
- **Table**: Data table with \`columns\` and \`rows\`
- **List**: List with \`items\` array
- **Chart**: Visualization with \`type\` (line, bar, pie), \`data\`, \`options\`

## Data Binding

Use JSON Pointer paths to bind component values to the data model:
\`\`\`json
{
  "id": "name-input",
  "component": "TextField",
  "value": { "path": "/user/name" },
  "label": "Your Name"
}
\`\`\`

## Example: Quick Poll

\`\`\`a2ui
{
  "surface": {
    "id": "poll-surface",
    "type": "inline",
    "title": "Quick Poll"
  },
  "components": [
    {
      "id": "root",
      "component": "Column",
      "children": ["question", "options", "submit"]
    },
    {
      "id": "question",
      "component": "Text",
      "text": "What's your preferred programming language?",
      "variant": "heading3"
    },
    {
      "id": "options",
      "component": "RadioGroup",
      "value": { "path": "/selection" },
      "options": [
        { "value": "python", "label": "Python" },
        { "value": "typescript", "label": "TypeScript" },
        { "value": "rust", "label": "Rust" },
        { "value": "go", "label": "Go" }
      ]
    },
    {
      "id": "submit",
      "component": "Button",
      "text": "Submit Vote",
      "action": "submit-poll",
      "variant": "primary"
    }
  ],
  "dataModel": {
    "selection": ""
  }
}
\`\`\`

## Rich Output (advanced visualizations)

For data and concepts that are clearer as an interactive visualization than as
text or a static chart, emit a **RichOutput** component. Set \`profileId\` to the
matching profile and populate the profile's payload field:

- **Charts** — \`profileId\`: \`"trends-over-time"\` (line), \`"category-comparison"\` (bar), or \`"part-of-whole"\` (pie). Payload:
  \`"chartData": { "labels": ["Jan", "Feb"], "datasets": [{ "label": "Revenue", "data": [10, 20] }] }\`
- **Network / force graph** — \`profileId\`: \`"network-graph"\`. Payload:
  \`"networkNodes": [{ "id": "a", "label": "A", "group": "core" }], "networkEdges": [{ "source": "a", "target": "b", "value": 2 }]\`
- **3D scene** — \`profileId\`: \`"3d-visualization"\`. Payload: \`"scenePrompt": "a rotating double helix"\`
- **Audio / synth** — \`profileId\`: \`"music-audio"\`. Payload: \`"audioPrompt": "a calm C-major arpeggio at 90bpm"\`
- **Physics / math simulation** — \`profileId\`: \`"physics-math-simulation"\`. Payload: \`"simulationConfig": { "type": "pendulum", "gravity": 9.8 }\`

Always include a \`title\` and a short text \`fallbackContent\` so the surface stays
useful if the visualization can't render. Example (a trend chart):

\`\`\`a2ui
{
  "surface": { "id": "sales-trend", "type": "inline", "title": "Sales Trend" },
  "components": [
    {
      "id": "root",
      "component": "RichOutput",
      "profileId": "trends-over-time",
      "title": "Quarterly Sales",
      "fallbackContent": "Q1 $10k, Q2 $20k, Q3 $35k",
      "chartData": {
        "labels": ["Q1", "Q2", "Q3"],
        "datasets": [{ "label": "Sales (k$)", "data": [10, 20, 35] }]
      }
    }
  ]
}
\`\`\`

Remember: Only use A2UI when it genuinely improves the user experience. For simple text responses, regular markdown is preferred.`

/**
 * Prompt to generate interactive forms
 */
export function buildA2UIFormPrompt(params: {
  purpose: string
  fields: Array<{ name: string; type: string; required?: boolean }>
  submitAction?: string
}): string {
  const { purpose, fields, submitAction = "submit" } = params

  const fieldsList = fields
    .map((f) => `- ${f.name} (${f.type})${f.required ? " [required]" : ""}`)
    .join("\n")

  return `Generate an A2UI form for: ${purpose}

Required fields:
${fieldsList}

The form should:
1. Have clear labels for each field
2. Include appropriate placeholder text
3. Use proper field types (TextField, TextArea, Select, etc.)
4. Include a submit button with action "${submitAction}"
5. Be well-organized using Row/Column layouts

Generate the A2UI JSON now.`
}

/**
 * Prompt to generate data dashboard
 */
export function buildA2UIDashboardPrompt(params: {
  title: string
  metrics: Array<{ name: string; value: string | number; trend?: "up" | "down" | "neutral" }>
  includeChart?: boolean
  chartType?: "line" | "bar" | "pie"
}): string {
  const { title, metrics, includeChart = false, chartType = "bar" } = params

  const metricsList = metrics
    .map((m) => `- ${m.name}: ${m.value}${m.trend ? ` (${m.trend})` : ""}`)
    .join("\n")

  return `Generate an A2UI dashboard for: ${title}

Metrics to display:
${metricsList}

The dashboard should:
1. Display each metric prominently with its value
2. Use appropriate colors for trends (green for up, red for down)
3. Be well-organized in a grid layout
${includeChart ? `4. Include a ${chartType} chart visualization` : ""}

Generate the A2UI JSON now.`
}

/**
 * Prompt to generate selection/choice interface
 */
export function buildA2UIChoicePrompt(params: {
  question: string
  options: Array<{ id: string; label: string; description?: string }>
  allowMultiple?: boolean
}): string {
  const { question, options, allowMultiple = false } = params

  const optionsList = options
    .map((o) => `- ${o.id}: ${o.label}${o.description ? ` - ${o.description}` : ""}`)
    .join("\n")

  return `Generate an A2UI ${allowMultiple ? "multi-select" : "single-select"} interface.

Question: ${question}

Options:
${optionsList}

The interface should:
1. Clearly display the question
2. Show all options with their descriptions
3. Use ${allowMultiple ? "Checkboxes" : "RadioGroup"} for selection
4. Include a confirm button

Generate the A2UI JSON now.`
}

/**
 * Prompt to generate wizard/multi-step interface
 */
export function buildA2UIWizardPrompt(params: {
  title: string
  steps: Array<{ id: string; title: string; description: string }>
  currentStep?: number
}): string {
  const { title, steps, currentStep = 0 } = params

  const stepsList = steps.map((s, i) => `${i + 1}. ${s.title}: ${s.description}`).join("\n")

  return `Generate an A2UI wizard interface for: ${title}

Steps:
${stepsList}

Current step: ${currentStep + 1}

The wizard should:
1. Show progress indicator with all steps
2. Highlight the current step
3. Display current step content
4. Include Back/Next navigation buttons
5. Show completion status for previous steps

Generate the A2UI JSON now.`
}

/**
 * Prompt to generate feedback/rating interface
 */
export function buildA2UIFeedbackPrompt(params: {
  title: string
  ratingType?: "stars" | "emoji" | "numeric"
  includeComment?: boolean
}): string {
  const { title, ratingType = "stars", includeComment = true } = params

  return `Generate an A2UI feedback interface for: ${title}

Requirements:
1. Rating using ${ratingType} scale
2. ${includeComment ? "Include a comment/feedback text area" : "No comment field needed"}
3. Submit button
4. Optional "Skip" action

The interface should be clean and easy to use.

Generate the A2UI JSON now.`
}

/**
 * Available A2UI templates for quick generation
 */
export const A2UI_TEMPLATES = {
  quickPoll: {
    name: "Quick Poll",
    description: "Simple voting interface with multiple options",
    prompt: "Generate an A2UI poll interface",
  },
  feedbackForm: {
    name: "Feedback Form",
    description: "Collect user feedback with rating and comments",
    prompt: "Generate an A2UI feedback form with star rating and comment",
  },
  settingsPanel: {
    name: "Settings Panel",
    description: "Configuration interface with various options",
    prompt: "Generate an A2UI settings panel",
  },
  dataCard: {
    name: "Data Card",
    description: "Display key metrics in a card format",
    prompt: "Generate an A2UI data card with metrics",
  },
  stepWizard: {
    name: "Step Wizard",
    description: "Multi-step guided interface",
    prompt: "Generate an A2UI step-by-step wizard",
  },
  confirmDialog: {
    name: "Confirmation Dialog",
    description: "Yes/No confirmation interface",
    prompt: "Generate an A2UI confirmation dialog",
  },
}

export type A2UITemplate = keyof typeof A2UI_TEMPLATES
