/**
 * Plugin Development Templates
 * Provides templates and scaffolding for creating new plugins
 */

import type { PluginManifest, PluginCapability, PluginType } from "@/types/plugin"

// =============================================================================
// Types
// =============================================================================

export interface PluginTemplate {
  id: string
  name: string
  description: string
  type: PluginType
  capabilities: PluginCapability[]
  difficulty: "beginner" | "intermediate" | "advanced"
  tags: string[]
  files: TemplateFile[]
  dependencies?: Record<string, string>
  pythonDependencies?: string[]
}

export interface TemplateFile {
  path: string
  content: string
  description?: string
}

export interface PluginScaffoldOptions {
  name: string
  id: string
  version?: string
  description: string
  author: {
    name: string
    email?: string
    url?: string
  }
  type: PluginType
  capabilities: PluginCapability[]
  template?: string
}

// =============================================================================
// Template Definitions
// =============================================================================

export const PLUGIN_TEMPLATES: PluginTemplate[] = [
  // Basic Tool Plugin
  {
    id: "basic-tool",
    name: "Basic Tool Plugin",
    description: "A simple plugin that provides a single tool for the AI agent",
    type: "frontend",
    capabilities: ["tools"],
    difficulty: "beginner",
    tags: ["tool", "simple", "starter"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "engines": {
    "cognia": ">=0.1.0"
  },
  "capabilities": ["tools"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.ts",
  "minAppVersion": "0.1.0"
}`,
      },
      {
        path: "index.ts",
        content: `/**
 * {{name}} - Plugin Entry Point
 */

import { definePlugin, registerPluginTools, tool } from '@cognia/plugin-sdk';
import type { PluginContext, PluginHooksAll } from '@cognia/plugin-sdk';

const exampleTool = tool({
  name: '{{id}}_tool',
  description: '{{description}}',
  parameters: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'The input to process',
      },
    },
    required: ['input'],
  },
  execute: async ({ input }: { input: string }) => {
    const result = \`Processed: \${input}\`;
    return { success: true, result };
  },
});

export default definePlugin({
  activate(context: PluginContext): PluginHooksAll {
    registerPluginTools(context, [exampleTool]);
    context.logger.info('{{name}} activated');

    return {
      onEnable: async () => {
        context.logger.info('{{name}} enabled');
      },
      onDisable: async () => {
        context.logger.info('{{name}} disabled');
      },
    };
  },
});
`,
      },
      {
        path: "README.md",
        content: `# {{name}}

{{description}}

## Installation

1. Copy this folder to your Cognia plugins directory
2. Enable the plugin in Settings > Plugins

## Usage

This plugin provides the \`{{id}}_tool\` tool that can be used by the AI agent.

## Development

\`\`\`bash
# Install dependencies
npm install

# Build
npm run build
\`\`\`
`,
      },
    ],
  },

  // Python Data Processing Plugin
  {
    id: "python-data",
    name: "Python Data Processing",
    description: "A Python plugin for data analysis and processing",
    type: "python",
    capabilities: ["tools", "python"],
    difficulty: "intermediate",
    tags: ["python", "data", "analysis"],
    pythonDependencies: ["pandas", "numpy"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "python",
  "capabilities": ["tools", "python"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "main.py",
  "pythonMain": "main.py",
  "pythonDependencies": ["pandas", "numpy"]
}`,
      },
      {
        path: "main.py",
        content: `"""
{{name}} - Python Plugin

{{description}}
"""

from cognia import Plugin, tool, hook
from cognia.types import ToolContext
import pandas as pd
import json


class {{className}}(Plugin):
    """{{description}}"""

    def on_load(self) -> None:
        """Called when the plugin is loaded."""
        self.log.info("Plugin loaded")

    def on_unload(self) -> None:
        """Called when the plugin is unloaded."""
        self.log.info("Plugin unloaded")

    @tool(
        name="analyze_data",
        description="Analyze data from a CSV or JSON source",
        parameters={
            "data": {"type": "string", "description": "Data as JSON string or file path"},
            "operation": {
                "type": "string",
                "enum": ["summary", "describe", "head", "tail"],
                "description": "Analysis operation to perform"
            }
        }
    )
    async def analyze_data(self, data: str, operation: str, ctx: ToolContext) -> dict:
        """Perform data analysis operations."""
        try:
            # Parse data
            if data.endswith('.csv'):
                df = pd.read_csv(data)
            elif data.endswith('.json'):
                df = pd.read_json(data)
            else:
                df = pd.DataFrame(json.loads(data))

            # Perform operation
            if operation == "summary":
                result = {
                    "rows": len(df),
                    "columns": list(df.columns),
                    "dtypes": {str(k): str(v) for k, v in df.dtypes.items()}
                }
            elif operation == "describe":
                result = df.describe().to_dict()
            elif operation == "head":
                result = df.head(10).to_dict(orient="records")
            elif operation == "tail":
                result = df.tail(10).to_dict(orient="records")
            else:
                return {"error": f"Unknown operation: {operation}"}

            return {"success": True, "result": result}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @hook("agent:before_response")
    async def on_before_response(self, data: dict) -> None:
        """Hook called before agent sends a response."""
        self.log.debug("Agent about to respond", data=data)


# Plugin entry point
plugin = {{className}}()
`,
      },
      {
        path: "requirements.txt",
        content: `pandas>=2.0.0
numpy>=1.24.0
`,
      },
      {
        path: "README.md",
        content: `# {{name}}

{{description}}

## Features

- Data analysis from CSV and JSON
- Statistical summaries
- DataFrame operations

## Installation

1. Copy to plugins directory
2. Install Python dependencies: \`pip install -r requirements.txt\`
3. Enable in Settings > Plugins

## Tools

### analyze_data
Analyze data with various operations:
- \`summary\`: Get row/column counts and data types
- \`describe\`: Statistical description
- \`head\`: First 10 rows
- \`tail\`: Last 10 rows
`,
      },
    ],
  },

  // A2UI Component Plugin
  {
    id: "a2ui-component",
    name: "A2UI Component Plugin",
    description: "A plugin that provides custom A2UI components",
    type: "frontend",
    capabilities: ["components", "a2ui"],
    difficulty: "intermediate",
    tags: ["a2ui", "ui", "component", "react"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "capabilities": ["components", "a2ui"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.tsx"
}`,
      },
      {
        path: "index.tsx",
        content: `/**
 * {{name}} - A2UI Component Plugin
 */

import React from 'react';
import type { PluginContext, PluginDefinition, A2UIComponentProps } from '@cognia/plugin-sdk';

// Custom A2UI Component
interface CustomCardProps extends A2UIComponentProps {
  title?: string;
  content?: string;
  variant?: 'default' | 'highlight' | 'subtle';
}

const CustomCard: React.FC<CustomCardProps> = ({
  title = 'Card Title',
  content = '',
  variant = 'default',
  children,
}) => {
  const variantStyles = {
    default: 'bg-card border',
    highlight: 'bg-primary/10 border-primary',
    subtle: 'bg-muted/50 border-muted',
  };

  return (
    <div className={\`rounded-lg p-4 \${variantStyles[variant]}\`}>
      {title && <h3 className="font-semibold mb-2">{title}</h3>}
      {content && <p className="text-muted-foreground">{content}</p>}
      {children}
    </div>
  );
};

export default function createPlugin(context: PluginContext): PluginDefinition {
  return {
    components: [
      {
        type: 'custom-card',
        component: CustomCard,
        metadata: {
          type: 'custom-card',
          name: 'Custom Card',
          description: 'A customizable card component',
          category: 'display',
          props: {
            title: { type: 'string', description: 'Card title' },
            content: { type: 'string', description: 'Card content' },
            variant: { type: 'string', enum: ['default', 'highlight', 'subtle'] },
          },
        },
      },
    ],
  };
}
`,
      },
    ],
  },

  // Agent Mode Plugin
  {
    id: "agent-mode",
    name: "Custom Agent Mode",
    description: "A plugin that adds a custom agent mode with specialized behavior",
    type: "frontend",
    capabilities: ["modes", "tools"],
    difficulty: "advanced",
    tags: ["agent", "mode", "ai", "specialized"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "capabilities": ["modes", "tools"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.ts",
  "configSchema": {
    "type": "object",
    "properties": {
      "temperature": {
        "type": "number",
        "default": 0.7,
        "minimum": 0,
        "maximum": 2,
        "description": "Response creativity level"
      },
      "maxTokens": {
        "type": "integer",
        "default": 2000,
        "description": "Maximum response length"
      }
    }
  }
}`,
      },
      {
        path: "index.ts",
        content: `/**
 * {{name}} - Custom Agent Mode Plugin
 */

import type { PluginContext, PluginDefinition } from '@cognia/plugin-sdk';

const SYSTEM_PROMPT = \`You are a specialized assistant for {{name}}.

Your capabilities:
- Specialized knowledge in the domain
- Access to custom tools provided by this plugin
- Focused and expert responses

Always be helpful, accurate, and concise.\`;

export default function createPlugin(context: PluginContext): PluginDefinition {
  const config = context.getConfig();

  return {
    modes: [
      {
        id: '{{id}}-mode',
        type: 'custom',
        name: '{{name}} Mode',
        description: '{{description}}',
        icon: 'sparkles',
        systemPrompt: SYSTEM_PROMPT,
        tools: ['{{id}}_search', '{{id}}_analyze'],
        settings: {
          temperature: config.temperature ?? 0.7,
          maxTokens: config.maxTokens ?? 2000,
        },
      },
    ],
    tools: [
      {
        name: '{{id}}_search',
        description: 'Search for relevant information',
        parametersSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
        execute: async (params: { query: string }) => {
          context.log.info('Searching:', params.query);
          // Implement search logic
          return { results: [] };
        },
      },
      {
        name: '{{id}}_analyze',
        description: 'Analyze content or data',
        parametersSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to analyze' },
            type: { type: 'string', enum: ['summary', 'sentiment', 'entities'] },
          },
          required: ['content', 'type'],
        },
        execute: async (params: { content: string; type: string }) => {
          context.log.info('Analyzing:', params.type);
          // Implement analysis logic
          return { analysis: {} };
        },
      },
    ],
    hooks: {
      'mode:activated': async () => {
        context.log.info('{{name}} mode activated');
      },
      'mode:deactivated': async () => {
        context.log.info('{{name}} mode deactivated');
      },
    },
  };
}
`,
      },
    ],
  },

  // Hybrid Full-Featured Plugin
  {
    id: "hybrid-full",
    name: "Full-Featured Hybrid Plugin",
    description: "A comprehensive plugin with frontend UI, Python backend, and full integration",
    type: "hybrid",
    capabilities: ["tools", "components", "modes", "a2ui", "python"],
    difficulty: "advanced",
    tags: ["hybrid", "full", "advanced", "python", "react"],
    pythonDependencies: ["aiohttp"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "hybrid",
  "capabilities": ["tools", "components", "modes", "a2ui", "python"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "frontend/index.tsx",
  "pythonMain": "backend/main.py",
  "pythonDependencies": ["aiohttp"],
  "configSchema": {
    "type": "object",
    "properties": {
      "apiEndpoint": {
        "type": "string",
        "default": "",
        "description": "External API endpoint"
      },
      "enableAdvanced": {
        "type": "boolean",
        "default": false,
        "description": "Enable advanced features"
      }
    }
  }
}`,
      },
      {
        path: "frontend/index.tsx",
        content: `/**
 * {{name}} - Frontend Entry
 */

import React from 'react';
import type { PluginContext, PluginDefinition } from '@cognia/plugin-sdk';

// Dashboard Component
const Dashboard: React.FC<{ data?: Record<string, unknown> }> = ({ data }) => (
  <div className="p-4 space-y-4">
    <h2 className="text-xl font-bold">{{name}} Dashboard</h2>
    <pre className="bg-muted p-2 rounded text-sm">
      {JSON.stringify(data, null, 2)}
    </pre>
  </div>
);

export default function createPlugin(context: PluginContext): PluginDefinition {
  return {
    components: [
      {
        type: '{{id}}-dashboard',
        component: Dashboard,
        metadata: {
          type: '{{id}}-dashboard',
          name: '{{name}} Dashboard',
          description: 'Main dashboard for {{name}}',
          category: 'dashboard',
        },
      },
    ],
    tools: [
      {
        name: '{{id}}_frontend_tool',
        description: 'A frontend-only tool',
        parametersSchema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
          },
        },
        execute: async (params) => {
          return { action: params.action, source: 'frontend' };
        },
      },
    ],
  };
}
`,
      },
      {
        path: "backend/main.py",
        content: `"""
{{name}} - Python Backend
"""

from cognia import Plugin, tool
from cognia.types import ToolContext
import aiohttp


class {{className}}Backend(Plugin):
    """Python backend for {{name}}"""

    def on_load(self) -> None:
        self.session = None
        self.log.info("Backend loaded")

    def on_unload(self) -> None:
        if self.session:
            # Close session in async context
            pass
        self.log.info("Backend unloaded")

    @tool(
        name="{{id}}_api_call",
        description="Make an API call to external service",
        parameters={
            "endpoint": {"type": "string", "description": "API endpoint path"},
            "method": {"type": "string", "enum": ["GET", "POST"], "default": "GET"},
            "data": {"type": "object", "description": "Request data (for POST)"}
        }
    )
    async def api_call(
        self,
        endpoint: str,
        method: str = "GET",
        data: dict = None,
        ctx: ToolContext = None
    ) -> dict:
        """Make an API call."""
        config = self.get_config()
        base_url = config.get("apiEndpoint", "")
        
        if not base_url:
            return {"error": "API endpoint not configured"}

        url = f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"
        
        try:
            async with aiohttp.ClientSession() as session:
                if method == "GET":
                    async with session.get(url) as resp:
                        return {"status": resp.status, "data": await resp.json()}
                else:
                    async with session.post(url, json=data) as resp:
                        return {"status": resp.status, "data": await resp.json()}
        except Exception as e:
            return {"error": str(e)}

    @tool(
        name="{{id}}_process",
        description="Process data with Python",
        parameters={
            "input": {"type": "string", "description": "Input data"},
            "operation": {"type": "string", "enum": ["transform", "validate", "analyze"]}
        }
    )
    async def process(self, input: str, operation: str, ctx: ToolContext) -> dict:
        """Process data."""
        if operation == "transform":
            return {"result": input.upper()}
        elif operation == "validate":
            return {"valid": len(input) > 0, "length": len(input)}
        elif operation == "analyze":
            return {
                "length": len(input),
                "words": len(input.split()),
                "chars": {c: input.count(c) for c in set(input) if c.isalpha()}
            }
        return {"error": "Unknown operation"}


plugin = {{className}}Backend()
`,
      },
      {
        path: "backend/requirements.txt",
        content: `aiohttp>=3.8.0
`,
      },
    ],
  },

  // Theme Plugin
  {
    id: "theme-plugin",
    name: "Theme Plugin",
    description: "A plugin that provides custom UI themes",
    type: "frontend",
    capabilities: ["themes"],
    difficulty: "beginner",
    tags: ["theme", "ui", "styling", "dark-mode", "light-mode"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "capabilities": ["themes"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.ts"
}`,
      },
      {
        path: "index.ts",
        content: `/**
 * {{name}} - Theme Plugin
 * 
 * Provides custom UI themes for Cognia
 */

import type { PluginContext, PluginDefinition } from '@cognia/plugin-sdk';

interface ThemeColors {
  background: string;
  foreground: string;
  primary: string;
  secondary: string;
  accent: string;
  muted: string;
  border: string;
  card: string;
  destructive: string;
}

interface Theme {
  id: string;
  name: string;
  description: string;
  isDark: boolean;
  colors: ThemeColors;
}

const themes: Theme[] = [
  {
    id: '{{id}}-ocean',
    name: 'Ocean Blue',
    description: 'A calming ocean-inspired dark theme',
    isDark: true,
    colors: {
      background: '#0a1628',
      foreground: '#e2e8f0',
      primary: '#0ea5e9',
      secondary: '#06b6d4',
      accent: '#22d3ee',
      muted: '#334155',
      border: '#1e3a5f',
      card: '#0f2744',
      destructive: '#ef4444',
    },
  },
  {
    id: '{{id}}-forest',
    name: 'Forest Green',
    description: 'A nature-inspired green theme',
    isDark: true,
    colors: {
      background: '#0d1f0d',
      foreground: '#e2f0e2',
      primary: '#22c55e',
      secondary: '#16a34a',
      accent: '#4ade80',
      muted: '#2d4a2d',
      border: '#1a3a1a',
      card: '#0f2a0f',
      destructive: '#ef4444',
    },
  },
  {
    id: '{{id}}-sunset',
    name: 'Sunset Glow',
    description: 'A warm sunset-inspired light theme',
    isDark: false,
    colors: {
      background: '#fff7ed',
      foreground: '#1c1917',
      primary: '#ea580c',
      secondary: '#f97316',
      accent: '#fb923c',
      muted: '#fed7aa',
      border: '#fdba74',
      card: '#ffedd5',
      destructive: '#dc2626',
    },
  },
];

export default function createPlugin(context: PluginContext): PluginDefinition {
  return {
    themes: themes.map(theme => ({
      id: theme.id,
      name: theme.name,
      description: theme.description,
      isDark: theme.isDark,
      apply: () => {
        context.log.info(\`Applying theme: \${theme.name}\`);
        // Apply CSS custom properties
        const root = document.documentElement;
        Object.entries(theme.colors).forEach(([key, value]) => {
          root.style.setProperty(\`--\${key}\`, value);
        });
      },
    })),
    
    hooks: {
      onEnable: async () => {
        context.log.info('Theme plugin enabled');
      },
      onDisable: async () => {
        context.log.info('Theme plugin disabled');
      },
    },
  };
}
`,
      },
      {
        path: "README.md",
        content: `# {{name}}

{{description}}

## Themes Included

- **Ocean Blue**: A calming ocean-inspired dark theme
- **Forest Green**: A nature-inspired green theme  
- **Sunset Glow**: A warm sunset-inspired light theme

## Installation

1. Copy to plugins directory
2. Enable in Settings > Plugins
3. Select a theme in Settings > Appearance

## Creating Custom Themes

Add new theme objects to the \`themes\` array with your custom colors.
`,
      },
    ],
  },

  // AI Provider Plugin
  {
    id: "ai-provider",
    name: "AI Provider Plugin",
    description: "A plugin that adds a custom AI model provider",
    type: "frontend",
    capabilities: ["providers"],
    difficulty: "advanced",
    tags: ["ai", "provider", "llm", "model", "api"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "capabilities": ["providers"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.ts",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "API key for the provider",
        "secret": true
      },
      "baseUrl": {
        "type": "string",
        "description": "Base URL for the API",
        "default": "https://api.example.com/v1"
      },
      "defaultModel": {
        "type": "string",
        "description": "Default model to use",
        "default": "model-v1"
      }
    },
    "required": ["apiKey"]
  },
  "permissions": ["network:fetch"]
}`,
      },
      {
        path: "index.ts",
        content: `/**
 * {{name}} - AI Provider Plugin
 * 
 * Adds a custom AI model provider to Cognia
 */

import type { PluginContext, PluginDefinition } from '@cognia/plugin-sdk';

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface StreamChunk {
  content: string;
  done: boolean;
}

export default function createPlugin(context: PluginContext): PluginDefinition {
  const config = context.config as {
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
  };

  return {
    providers: [
      {
        id: '{{id}}-provider',
        name: '{{name}}',
        description: '{{description}}',
        models: [
          {
            id: 'model-v1',
            name: 'Model V1',
            contextLength: 128000,
            pricing: { input: 0.001, output: 0.002 },
          },
          {
            id: 'model-v2',
            name: 'Model V2 (Fast)',
            contextLength: 32000,
            pricing: { input: 0.0005, output: 0.001 },
          },
        ],
        
        async chat(messages: Message[], options?: { model?: string }): Promise<string> {
          const model = options?.model || config.defaultModel;
          
          const response = await fetch(\`\${config.baseUrl}/chat/completions\`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': \`Bearer \${config.apiKey}\`,
            },
            body: JSON.stringify({
              model,
              messages,
            }),
          });
          
          if (!response.ok) {
            throw new Error(\`API error: \${response.statusText}\`);
          }
          
          const data = await response.json();
          return data.choices[0].message.content;
        },
        
        async *stream(messages: Message[], options?: { model?: string }): AsyncGenerator<StreamChunk> {
          const model = options?.model || config.defaultModel;
          
          const response = await fetch(\`\${config.baseUrl}/chat/completions\`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': \`Bearer \${config.apiKey}\`,
            },
            body: JSON.stringify({
              model,
              messages,
              stream: true,
            }),
          });
          
          if (!response.ok) {
            throw new Error(\`API error: \${response.statusText}\`);
          }
          
          const reader = response.body?.getReader();
          if (!reader) throw new Error('No response body');
          
          const decoder = new TextDecoder();
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              yield { content: '', done: true };
              break;
            }
            
            const chunk = decoder.decode(value);
            // Parse SSE format
            const lines = chunk.split('\\n').filter(line => line.startsWith('data: '));
            
            for (const line of lines) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                yield { content: '', done: true };
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices[0]?.delta?.content || '';
                if (content) {
                  yield { content, done: false };
                }
              } catch {
                // Skip invalid JSON
              }
            }
          }
        },
      },
    ],
  };
}
`,
      },
      {
        path: "README.md",
        content: `# {{name}}

{{description}}

## Configuration

Set your API key and base URL in the plugin settings.

## Models

- **Model V1**: Full featured model with 128k context
- **Model V2 (Fast)**: Optimized for speed with 32k context

## Usage

Once configured, select the provider and model in Settings > AI.
`,
      },
    ],
  },

  // Export Plugin
  {
    id: "exporter-plugin",
    name: "Export Plugin",
    description: "A plugin that adds custom export formats",
    type: "frontend",
    capabilities: ["exporters"],
    difficulty: "intermediate",
    tags: ["export", "pdf", "markdown", "docx", "format"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "capabilities": ["exporters"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.ts"
}`,
      },
      {
        path: "index.ts",
        content: `/**
 * {{name}} - Export Plugin
 * 
 * Provides custom export formats for conversations and artifacts
 */

import type { PluginContext, PluginDefinition } from '@cognia/plugin-sdk';

interface ExportContent {
  type: 'conversation' | 'artifact' | 'document';
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export default function createPlugin(context: PluginContext): PluginDefinition {
  return {
    exporters: [
      {
        id: 'markdown-enhanced',
        name: 'Enhanced Markdown',
        description: 'Export with improved formatting and metadata',
        extension: '.md',
        mimeType: 'text/markdown',
        
        async export(content: ExportContent): Promise<Blob> {
          const now = new Date().toISOString();
          
          let output = \`---
title: \${content.title}
date: \${now}
type: \${content.type}
---

# \${content.title}

\${content.content}

---
*Exported from Cognia on \${new Date().toLocaleDateString()}*
\`;
          
          return new Blob([output], { type: 'text/markdown' });
        },
      },
      {
        id: 'html-styled',
        name: 'Styled HTML',
        description: 'Export as styled HTML document',
        extension: '.html',
        mimeType: 'text/html',
        
        async export(content: ExportContent): Promise<Blob> {
          const html = \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>\${content.title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      line-height: 1.6;
      color: #333;
    }
    h1 { color: #1a1a1a; border-bottom: 2px solid #eee; padding-bottom: 0.5rem; }
    pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; }
    code { font-family: 'Fira Code', monospace; }
    .metadata { color: #666; font-size: 0.875rem; margin-bottom: 2rem; }
  </style>
</head>
<body>
  <h1>\${content.title}</h1>
  <div class="metadata">Type: \${content.type} | Exported: \${new Date().toLocaleDateString()}</div>
  <div class="content">
    \${content.content.replace(/\\n/g, '<br>')}
  </div>
</body>
</html>\`;
          
          return new Blob([html], { type: 'text/html' });
        },
      },
      {
        id: 'json-export',
        name: 'JSON Export',
        description: 'Export as structured JSON with metadata',
        extension: '.json',
        mimeType: 'application/json',
        
        async export(content: ExportContent): Promise<Blob> {
          const data = {
            exportedAt: new Date().toISOString(),
            exportedBy: '{{id}}',
            ...content,
          };
          
          return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        },
      },
    ],
  };
}
`,
      },
      {
        path: "README.md",
        content: `# {{name}}

{{description}}

## Export Formats

- **Enhanced Markdown**: Markdown with YAML frontmatter
- **Styled HTML**: Standalone HTML with embedded styles
- **JSON Export**: Structured JSON with full metadata

## Usage

Select the export format when exporting conversations or artifacts.
`,
      },
    ],
  },

  // Message Processor Plugin
  {
    id: "processor-plugin",
    name: "Message Processor Plugin",
    description: "A plugin that processes and transforms messages",
    type: "frontend",
    capabilities: ["processors", "hooks"],
    difficulty: "intermediate",
    tags: ["processor", "transform", "filter", "messages"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "capabilities": ["processors", "hooks"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.ts",
  "configSchema": {
    "type": "object",
    "properties": {
      "enableSanitization": {
        "type": "boolean",
        "description": "Enable message sanitization",
        "default": true
      },
      "enableFormatting": {
        "type": "boolean",
        "description": "Enable automatic formatting",
        "default": true
      }
    }
  }
}`,
      },
      {
        path: "index.ts",
        content: `/**
 * {{name}} - Message Processor Plugin
 * 
 * Processes and transforms messages before and after AI processing
 */

import type { PluginContext, PluginDefinition } from '@cognia/plugin-sdk';

interface Message {
  role: string;
  content: string;
}

export default function createPlugin(context: PluginContext): PluginDefinition {
  const config = context.config as {
    enableSanitization: boolean;
    enableFormatting: boolean;
  };

  // Sanitize potentially sensitive data
  function sanitize(text: string): string {
    // Remove common patterns of sensitive data
    return text
      .replace(/\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b/g, '[EMAIL]')
      .replace(/\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b/g, '[PHONE]')
      .replace(/\\b(?:\\d{4}[- ]?){3}\\d{4}\\b/g, '[CARD]')
      .replace(/\\b\\d{3}-\\d{2}-\\d{4}\\b/g, '[SSN]');
  }

  // Format code blocks
  function formatCode(text: string): string {
    // Auto-detect language for code blocks without language
    return text.replace(/\\\`\\\`\\\`\\n([\\s\\S]*?)\\\`\\\`\\\`/g, (match, code) => {
      const firstLine = code.split('\\n')[0].trim();
      let lang = '';
      
      if (firstLine.includes('function') || firstLine.includes('const ') || firstLine.includes('let ')) {
        lang = 'javascript';
      } else if (firstLine.includes('def ') || firstLine.includes('import ')) {
        lang = 'python';
      } else if (firstLine.includes('fn ') || firstLine.includes('let mut')) {
        lang = 'rust';
      }
      
      return lang ? \`\\\`\\\`\\\`\${lang}\\n\${code}\\\`\\\`\\\`\` : match;
    });
  }

  return {
    processors: [
      {
        id: 'input-processor',
        name: 'Input Processor',
        phase: 'pre',
        priority: 10,
        
        async process(message: Message): Promise<Message> {
          let content = message.content;
          
          if (config.enableSanitization) {
            content = sanitize(content);
          }
          
          return { ...message, content };
        },
      },
      {
        id: 'output-processor',
        name: 'Output Processor',
        phase: 'post',
        priority: 10,
        
        async process(message: Message): Promise<Message> {
          let content = message.content;
          
          if (config.enableFormatting && message.role === 'assistant') {
            content = formatCode(content);
          }
          
          return { ...message, content };
        },
      },
    ],
    
    hooks: {
      onEnable: async () => {
        context.log.info('Message processor enabled');
      },
      onMessage: async (message) => {
        context.log.debug('Processing message', { role: message.role });
      },
    },
  };
}
`,
      },
      {
        path: "README.md",
        content: `# {{name}}

{{description}}

## Features

### Input Processing
- **Sanitization**: Automatically masks sensitive data (emails, phone numbers, credit cards, SSN)

### Output Processing
- **Code Formatting**: Auto-detects language for code blocks

## Configuration

- \`enableSanitization\`: Enable/disable sensitive data masking
- \`enableFormatting\`: Enable/disable automatic code formatting
`,
      },
    ],
  },

  // Media Processing Plugin Template
  {
    id: "media-processing",
    name: "Media Processing Plugin",
    description:
      "A plugin that provides custom image filters, video effects, and transitions for the media studio",
    type: "frontend",
    capabilities: ["tools", "components"],
    difficulty: "intermediate",
    tags: ["media", "image", "video", "filter", "effect", "transition"],
    files: [
      {
        path: "plugin.json",
        content: `{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "1.0.0",
  "description": "{{description}}",
  "type": "frontend",
  "capabilities": ["tools", "components"],
  "author": {
    "name": "{{author.name}}"
  },
  "main": "index.ts",
  "contributes": {
    "imageFilters": true,
    "videoEffects": true,
    "videoTransitions": true
  }
}`,
      },
      {
        path: "index.ts",
        content: `/**
 * {{name}} - Media Processing Plugin
 * 
 * Provides custom image filters, video effects, and transitions
 */

import type { PluginContext, PluginDefinition } from '@cognia/plugin-sdk';
import type { 
  ImageFilterDefinition, 
  VideoEffectDefinition, 
  VideoTransitionDefinition 
} from '@cognia/plugin-sdk/media';

// Custom Image Filter: Vintage
const vintageFilter: ImageFilterDefinition = {
  id: 'vintage',
  name: 'Vintage',
  description: 'Apply a vintage film look',
  category: 'stylize',
  icon: '📷',
  parameters: [
    { id: 'intensity', name: 'Intensity', type: 'number', default: 50, min: 0, max: 100 },
    { id: 'vignette', name: 'Vignette', type: 'boolean', default: true },
  ],
  apply: (imageData, params) => {
    const intensity = ((params?.intensity as number) || 50) / 100;
    const data = new Uint8ClampedArray(imageData.data);
    
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      
      // Sepia tone
      const sepiaR = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
      const sepiaG = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
      const sepiaB = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
      
      // Blend with intensity
      data[i] = r + (sepiaR - r) * intensity;
      data[i + 1] = g + (sepiaG - g) * intensity;
      data[i + 2] = b + (sepiaB - b) * intensity;
      
      // Add slight contrast
      data[i] = Math.min(255, Math.max(0, (data[i] - 128) * 1.1 + 128));
      data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] - 128) * 1.1 + 128));
      data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] - 128) * 1.1 + 128));
    }
    
    return new ImageData(data, imageData.width, imageData.height);
  },
};

// Custom Image Filter: Neon Glow
const neonGlowFilter: ImageFilterDefinition = {
  id: 'neon-glow',
  name: 'Neon Glow',
  description: 'Add a neon glow effect',
  category: 'stylize',
  icon: '✨',
  parameters: [
    { id: 'color', name: 'Glow Color', type: 'color', default: '#ff00ff' },
    { id: 'intensity', name: 'Intensity', type: 'number', default: 50, min: 0, max: 100 },
  ],
  apply: (imageData, params) => {
    const color = params?.color as string || '#ff00ff';
    const intensity = ((params?.intensity as number) || 50) / 100;
    const data = new Uint8ClampedArray(imageData.data);
    
    // Parse hex color
    const glowR = parseInt(color.slice(1, 3), 16);
    const glowG = parseInt(color.slice(3, 5), 16);
    const glowB = parseInt(color.slice(5, 7), 16);
    
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3 / 255;
      
      // Add glow to bright areas
      if (brightness > 0.5) {
        const glowAmount = (brightness - 0.5) * 2 * intensity;
        data[i] = Math.min(255, data[i] + glowR * glowAmount);
        data[i + 1] = Math.min(255, data[i + 1] + glowG * glowAmount);
        data[i + 2] = Math.min(255, data[i + 2] + glowB * glowAmount);
      }
    }
    
    return new ImageData(data, imageData.width, imageData.height);
  },
};

// Custom Video Effect: Color Shift
const colorShiftEffect: VideoEffectDefinition = {
  id: 'color-shift',
  name: 'Color Shift',
  description: 'Animated RGB color channel shift',
  category: 'stylize',
  icon: '🌈',
  supportsKeyframes: true,
  parameters: [
    { id: 'amount', name: 'Shift Amount', type: 'number', default: 10, min: 0, max: 50 },
    { id: 'animate', name: 'Animate', type: 'boolean', default: true },
  ],
  apply: (frame, params, time) => {
    const amount = (params?.amount as number) || 10;
    const animate = params?.animate !== false;
    const data = new Uint8ClampedArray(frame.data);
    
    // Calculate animated offset
    const offset = animate && time !== undefined 
      ? Math.sin(time * 2) * amount 
      : amount;
    
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const i = (y * frame.width + x) * 4;
        
        // Shift red channel
        const shiftedX = Math.min(frame.width - 1, Math.max(0, x + Math.round(offset)));
        const shiftedI = (y * frame.width + shiftedX) * 4;
        
        data[i] = frame.data[shiftedI]; // Red from shifted position
        data[i + 1] = frame.data[i + 1]; // Green stays
        data[i + 2] = frame.data[i + 2]; // Blue stays
        data[i + 3] = frame.data[i + 3]; // Alpha stays
      }
    }
    
    return new ImageData(data, frame.width, frame.height);
  },
};

// Custom Video Transition: Glitch
const glitchTransition: VideoTransitionDefinition = {
  id: 'glitch',
  name: 'Glitch',
  description: 'Digital glitch transition effect',
  icon: '📺',
  minDuration: 0.2,
  maxDuration: 2,
  defaultDuration: 0.5,
  render: (fromFrame, toFrame, progress) => {
    const data = new Uint8ClampedArray(fromFrame.data.length);
    const sliceHeight = Math.max(2, Math.floor(fromFrame.height / 20));
    
    for (let y = 0; y < fromFrame.height; y++) {
      const sliceIndex = Math.floor(y / sliceHeight);
      const useToFrame = (sliceIndex + Math.floor(progress * 10)) % 2 === 0 && progress > 0.3;
      const sourceFrame = useToFrame ? toFrame : fromFrame;
      
      // Random horizontal offset for glitch effect
      const offset = Math.random() < 0.1 ? Math.floor(Math.random() * 20 - 10) : 0;
      
      for (let x = 0; x < fromFrame.width; x++) {
        const srcX = Math.min(fromFrame.width - 1, Math.max(0, x + offset));
        const i = (y * fromFrame.width + x) * 4;
        const srcI = (y * sourceFrame.width + srcX) * 4;
        
        data[i] = sourceFrame.data[srcI];
        data[i + 1] = sourceFrame.data[srcI + 1];
        data[i + 2] = sourceFrame.data[srcI + 2];
        data[i + 3] = 255;
      }
    }
    
    return new ImageData(data, fromFrame.width, fromFrame.height);
  },
};

export default function createPlugin(context: PluginContext): PluginDefinition {
  const { media, log } = context;
  
  // Register image filters
  media.filters.register(vintageFilter);
  media.filters.register(neonGlowFilter);
  log.info('Registered image filters: vintage, neon-glow');
  
  // Register video effects
  media.effects.register(colorShiftEffect);
  log.info('Registered video effects: color-shift');
  
  // Register video transitions
  media.transitions.register(glitchTransition);
  log.info('Registered video transitions: glitch');
  
  return {
    hooks: {
      onEnable: async () => {
        log.info('Media processing plugin enabled');
      },
      onDisable: async () => {
        // Unregister all contributions
        media.filters.unregister('vintage');
        media.filters.unregister('neon-glow');
        media.effects.unregister('color-shift');
        media.transitions.unregister('glitch');
        log.info('Media processing plugin disabled');
      },
    },
  };
}
`,
      },
      {
        path: "README.md",
        content: `# {{name}}

{{description}}

## Image Filters

### Vintage
Apply a vintage film look with adjustable intensity and optional vignette.

### Neon Glow
Add a colorful neon glow effect to bright areas of the image.

## Video Effects

### Color Shift
Animated RGB color channel separation effect.

## Video Transitions

### Glitch
Digital glitch transition with horizontal slices and offset effects.

## Usage

1. Install this plugin in your Cognia plugins directory
2. Enable it in Settings > Plugins
3. The filters, effects, and transitions will appear in:
   - Image Studio > Filters Gallery
   - Video Studio > Effects Panel
   - Video Studio > Transitions

## API

This plugin uses the Cognia Media API:

\\\`\\\`\\\`typescript
// Register an image filter
context.media.filters.register({
  id: 'my-filter',
  name: 'My Filter',
  category: 'stylize',
  apply: (imageData, params) => {
    // Process and return modified ImageData
  }
});

// Register a video effect
context.media.effects.register({
  id: 'my-effect',
  name: 'My Effect',
  category: 'color',
  supportsKeyframes: true,
  apply: (frame, params, time) => {
    // Process and return modified frame
  }
});

// Register a video transition
context.media.transitions.register({
  id: 'my-transition',
  name: 'My Transition',
  minDuration: 0.1,
  maxDuration: 3,
  defaultDuration: 1,
  render: (fromFrame, toFrame, progress) => {
    // Blend frames based on progress (0-1)
  }
});
\\\`\\\`\\\`
`,
      },
    ],
  },
]

// =============================================================================
// Template Functions
// =============================================================================

function toClassName(name: string): string {
  return name
    .split(/[\s-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("")
}

function processTemplate(content: string, options: PluginScaffoldOptions): string {
  const className = toClassName(options.name)
  const version = options.version || "1.0.0"

  return content
    .replace(/\{\{id\}\}/g, options.id)
    .replace(/\{\{version\}\}/g, version)
    .replace(/\{\{name\}\}/g, options.name)
    .replace(/\{\{description\}\}/g, options.description)
    .replace(/\{\{author\.name\}\}/g, options.author.name)
    .replace(/\{\{author\.email\}\}/g, options.author.email || "")
    .replace(/\{\{author\.url\}\}/g, options.author.url || "")
    .replace(/\{\{className\}\}/g, className)
    .replace(/"version":\s*"1\.0\.0"/g, `"version": "${version}"`)
}

/**
 * Co-located test stub for a scaffolded plugin — the runtime half of the
 * scaffold healthcheck. The scaffold-time check (`scaffold-healthcheck.ts`)
 * is static by necessity (the app can't compile the emitted TS); this stub
 * runs in the plugin author's environment where the module IS compilable and
 * asserts the manifest parses and the entry actually activates.
 */
function buildScaffoldTestFile(
  options: PluginScaffoldOptions,
  mainFile: string
): {
  path: string
  content: string
} {
  if (options.type === "python" || mainFile.endsWith(".py")) {
    return {
      path: "test_main.py",
      content: `"""Scaffolded smoke test for ${options.name} — extend with real cases."""

import json
import pathlib


def test_manifest_is_valid_json():
    manifest = json.loads((pathlib.Path(__file__).parent / "plugin.json").read_text())
    assert manifest["id"] == "${options.id}"
    assert manifest["main"] == "${mainFile}"


def test_entry_module_imports_and_exposes_a_plugin():
    import main

    assert hasattr(main, "plugin")
`,
    }
  }

  const entryImport = `./${mainFile.replace(/\.(ts|tsx|js)$/, "")}`
  return {
    path: mainFile.replace(/\.(ts|tsx|js)$/, ".test.$1"),
    content: `/**
 * Scaffolded smoke test for ${options.name} — extend with real cases.
 *
 * Asserts the two things the scaffold cannot prove statically: the manifest
 * round-trips as JSON with the expected identity, and the entry module
 * compiles + exposes an activatable plugin definition.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "${entryImport}"

describe("${options.id} scaffold", () => {
  it("ships a parsable manifest with matching identity", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"))
    expect(manifest.id).toBe("${options.id}")
    expect(manifest.main).toBe("${mainFile}")
  })

  it("entry module exposes an activatable plugin", () => {
    expect(plugin).toBeDefined()
    expect(typeof (plugin as { activate?: unknown }).activate).toBe("function")
  })
})
`,
  }
}

/** Resolve the manifest `main` recorded in an emitted file map (falls back per type). */
function mainFileOf(files: Map<string, string>, options: PluginScaffoldOptions): string {
  const raw = files.get("plugin.json")
  if (raw) {
    try {
      const main = (JSON.parse(raw) as { main?: unknown }).main
      if (typeof main === "string" && main !== "") return main
    } catch {
      // healthcheck reports unparsable manifests; fall through to the default
    }
  }
  return options.type === "python" ? "main.py" : "index.ts"
}

export function scaffoldPlugin(options: PluginScaffoldOptions): Map<string, string> {
  const template = options.template
    ? PLUGIN_TEMPLATES.find((t) => t.id === options.template)
    : PLUGIN_TEMPLATES.find(
        (t) =>
          t.type === options.type && t.capabilities.some((c) => options.capabilities.includes(c))
      )

  const files = new Map<string, string>()
  if (!template) {
    // Generate basic plugin from scratch
    for (const [path, content] of generateBasicPlugin(options)) files.set(path, content)
  } else {
    for (const file of template.files) {
      files.set(file.path, processTemplate(file.content, options))
    }
  }

  // Every scaffold ships a co-located test (repo rule: no untested modules) —
  // unless the template already provides one.
  const testFile = buildScaffoldTestFile(options, mainFileOf(files, options))
  if (!files.has(testFile.path)) files.set(testFile.path, testFile.content)

  return files
}

export interface ScaffoldResult {
  files: Map<string, string>
  health: import("./scaffold-healthcheck").ScaffoldHealthReport
}

/**
 * `scaffoldPlugin` + `healthcheckScaffold` in one call. Callers integrating
 * plugin creation MUST use this variant and surface `health.issues` — a
 * scaffold with `ok: false` must never be written out as a success.
 */
export function scaffoldPluginChecked(options: PluginScaffoldOptions): ScaffoldResult {
  // Lazy import avoids a cycle: scaffold-healthcheck → core/validation is a
  // heavier module graph than templates.ts needs at load time.
  const { healthcheckScaffold } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./scaffold-healthcheck") as typeof import("./scaffold-healthcheck")
  const files = scaffoldPlugin(options)
  return { files, health: healthcheckScaffold(files) }
}

function generateBasicPlugin(options: PluginScaffoldOptions): Map<string, string> {
  const files = new Map<string, string>()
  const version = options.version || "1.0.0"

  // Generate manifest
  const manifest: PluginManifest = {
    id: options.id,
    name: options.name,
    version,
    description: options.description,
    type: options.type,
    capabilities: options.capabilities,
    author: options.author,
    main: options.type === "python" ? "main.py" : "index.ts",
    ...(options.type === "python" ? { pythonMain: "main.py" } : {}),
    engines: {
      cognia: ">=0.1.0",
    },
    minAppVersion: "0.1.0",
  }

  files.set("plugin.json", JSON.stringify(manifest, null, 2))

  // Generate main file based on type
  if (options.type === "python") {
    files.set(
      "main.py",
      `"""
${options.name}

${options.description}
"""

from cognia import Plugin


class ${toClassName(options.name)}(Plugin):
    """${options.description}"""

    def on_load(self) -> None:
        self.log.info("Plugin loaded")

    def on_unload(self) -> None:
        self.log.info("Plugin unloaded")


plugin = ${toClassName(options.name)}()
`
    )
  } else {
    const needsTools = options.capabilities.includes("tools")
    const needsComponents = options.capabilities.includes("components")
    const needsHooks = options.capabilities.includes("hooks")
    const helperImports = ["definePlugin"]
    if (needsTools) {
      helperImports.push("registerPluginTools", "tool")
    }
    const importLines = [`import { ${helperImports.join(", ")} } from '@cognia/plugin-sdk';`]
    if (needsComponents) {
      importLines.unshift(`import React from 'react';`)
    }

    const toolExample = needsTools
      ? `
const exampleTool = tool({
  name: '${options.id.replace(/-/g, "_")}_echo',
  description: 'Echo a message from ${options.name}',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo back' },
    },
    required: ['text'],
  },
  execute: async ({ text }: { text: string }) => ({ echoed: text }),
});
`
      : ""

    const componentExample = needsComponents
      ? `
const ${toClassName(options.name)}Panel = () =>
  React.createElement(
    'div',
    { className: 'rounded-lg border p-4 text-sm' },
    '${options.name} component ready'
  );
`
      : ""

    const activateLines = [
      needsTools ? "    registerPluginTools(context, [exampleTool]);" : "",
      needsComponents
        ? `    context.a2ui.registerComponent({
      type: '${options.id}-panel',
      component: ${toClassName(options.name)}Panel,
      metadata: {
        type: '${options.id}-panel',
        name: '${options.name} Panel',
        description: '${options.description || `${options.name} component panel`}',
        category: 'dashboard',
      },
    });`
        : "",
      `    context.logger.info('${options.name} activated');`,
    ]
      .filter(Boolean)
      .join("\n")

    const hookEntries = [
      needsHooks
        ? `      onSessionCreate: async (sessionId) => {
        context.logger.info(\`Session created: \${sessionId}\`);
      },`
        : "",
      `      onEnable: async () => {
        context.logger.info('${options.name} enabled');
      },`,
      `      onDisable: async () => {
        context.logger.info('${options.name} disabled');
      },`,
    ]
      .filter(Boolean)
      .join("\n")

    files.set(
      "index.ts",
      `/**
 * ${options.name}
 *
 * ${options.description}
 */

${importLines.join("\n")}
import type { PluginContext, PluginHooksAll } from '@cognia/plugin-sdk';

${toolExample}${componentExample}
export default definePlugin({
  activate(context: PluginContext): PluginHooksAll {
${activateLines}

    return {
${hookEntries}
    };
  },
});
`
    )
  }

  // Generate README
  files.set(
    "README.md",
    `# ${options.name}

${options.description}

## Author

${options.author.name}${options.author.email ? ` <${options.author.email}>` : ""}

## Installation

1. Copy this folder to your Cognia plugins directory
2. Enable the plugin in Settings > Plugins

## License

MIT
`
  )

  return files
}

export function getTemplateById(id: string): PluginTemplate | undefined {
  return PLUGIN_TEMPLATES.find((t) => t.id === id)
}

export function getTemplatesByType(type: PluginType): PluginTemplate[] {
  return PLUGIN_TEMPLATES.filter((t) => t.type === type)
}

export function getTemplatesByCapability(capability: PluginCapability): PluginTemplate[] {
  return PLUGIN_TEMPLATES.filter((t) => t.capabilities.includes(capability))
}

export function getTemplatesByDifficulty(
  difficulty: PluginTemplate["difficulty"]
): PluginTemplate[] {
  return PLUGIN_TEMPLATES.filter((t) => t.difficulty === difficulty)
}

export function searchTemplates(query: string): PluginTemplate[] {
  const lowerQuery = query.toLowerCase()
  return PLUGIN_TEMPLATES.filter(
    (t) =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery) ||
      t.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
  )
}
