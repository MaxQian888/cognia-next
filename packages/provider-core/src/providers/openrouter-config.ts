/**
 * OpenRouter configuration helpers and constants
 * Extracted from components/settings/provider/openrouter-settings.tsx
 */

import type { BYOKProvider } from "@cognia/provider-types"

// BYOK Provider configurations
export interface BYOKProviderConfig {
  id: BYOKProvider
  name: string
  description: string
  configType: "simple" | "azure" | "bedrock" | "vertex"
}

export const BYOK_PROVIDERS: BYOKProviderConfig[] = [
  { id: "openai", name: "OpenAI", description: "GPT-4, GPT-4o, o1 models", configType: "simple" },
  { id: "anthropic", name: "Anthropic", description: "Claude models", configType: "simple" },
  { id: "google", name: "Google AI", description: "Gemini models", configType: "simple" },
  { id: "mistral", name: "Mistral AI", description: "Mistral models", configType: "simple" },
  { id: "cohere", name: "Cohere", description: "Command models", configType: "simple" },
  { id: "groq", name: "Groq", description: "Fast inference", configType: "simple" },
  {
    id: "azure",
    name: "Azure AI Services",
    description: "Azure-hosted models",
    configType: "azure",
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    description: "AWS-hosted models",
    configType: "bedrock",
  },
  {
    id: "vertex",
    name: "Google Vertex AI",
    description: "Enterprise Google AI",
    configType: "vertex",
  },
]

// Get configuration placeholder text based on config type
export function getConfigPlaceholder(configType?: string): string {
  switch (configType) {
    case "azure":
      return `{
  "model_slug": "openai/gpt-4o",
  "endpoint_url": "https://your-resource.openai.azure.com/...",
  "api_key": "your-azure-api-key",
  "model_id": "gpt-4o"
}`
    case "bedrock":
      return `Option 1 (API Key): your-bedrock-api-key

Option 2 (Credentials):
{
  "accessKeyId": "your-access-key-id",
  "secretAccessKey": "your-secret-access-key",
  "region": "us-east-1"
}`
    case "vertex":
      return `{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----...",
  "client_email": "...",
  "region": "global"
}`
    default:
      return ""
  }
}

// Get configuration help text based on config type
export function getConfigHelp(configType?: string): string {
  switch (configType) {
    case "azure":
      return "Enter Azure AI Services configuration as JSON. Multiple deployments supported."
    case "bedrock":
      return "Enter Bedrock API key or AWS credentials JSON."
    case "vertex":
      return "Enter Google Cloud service account key JSON."
    default:
      return ""
  }
}
