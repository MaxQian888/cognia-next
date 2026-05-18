/**
 * OCR provider parameter schemas.
 *
 * These ride on the same {@link ParameterDefinition} shape the main provider
 * settings UI uses, so `components/settings/provider/provider-parameters-tab.tsx`'s
 * dynamic form renderer works against OCR provider config too. Per-provider
 * config is stored under `UserOcrSettings.providerConfig[providerId]`.
 *
 * The keys here are i18n keys — translations live in
 * `i18n/messages/en.json` and `i18n/messages/zh-CN.json` under `ocr.params.*`.
 */

import type {
  ParameterDefinition,
  ProviderParameterSchema,
} from "@/types/provider/provider-parameter-schema"

const PROVIDER_PARAM_PREFIX = "ocr.params"

/** Shared parameters that show up on every provider config tab. */
const COMMON_PARAMETERS: ParameterDefinition[] = [
  {
    key: "languages",
    type: "text",
    label: `${PROVIDER_PARAM_PREFIX}.languages.label`,
    description: `${PROVIDER_PARAM_PREFIX}.languages.description`,
    category: "inference",
    defaultValue: "en",
  },
  {
    key: "format",
    type: "select",
    label: `${PROVIDER_PARAM_PREFIX}.format.label`,
    description: `${PROVIDER_PARAM_PREFIX}.format.description`,
    category: "inference",
    defaultValue: "markdown",
    validation: {
      options: [
        { value: "markdown", label: `${PROVIDER_PARAM_PREFIX}.format.markdown` },
        { value: "text", label: `${PROVIDER_PARAM_PREFIX}.format.text` },
        { value: "blocks", label: `${PROVIDER_PARAM_PREFIX}.format.blocks` },
      ],
    },
  },
  {
    key: "pageRange",
    type: "text",
    label: `${PROVIDER_PARAM_PREFIX}.pageRange.label`,
    description: `${PROVIDER_PARAM_PREFIX}.pageRange.description`,
    category: "inference",
    defaultValue: "",
  },
  {
    key: "maxImageDimension",
    type: "number",
    label: `${PROVIDER_PARAM_PREFIX}.maxImageDimension.label`,
    description: `${PROVIDER_PARAM_PREFIX}.maxImageDimension.description`,
    category: "advanced",
    defaultValue: 2000,
    validation: { min: 256, max: 8192, step: 64 },
  },
]

const PROMPT_TEMPLATE_PARAM: ParameterDefinition = {
  key: "promptTemplate",
  type: "text",
  label: `${PROVIDER_PARAM_PREFIX}.promptTemplate.label`,
  description: `${PROVIDER_PARAM_PREFIX}.promptTemplate.description`,
  category: "provider-specific",
  defaultValue:
    "Extract every word of text from the supplied page image and return it as well-structured Markdown. Preserve tables, lists, and reading order. Do not add commentary.",
}

const MODEL_PARAM = (defaultValue: string): ParameterDefinition => ({
  key: "model",
  type: "text",
  label: `${PROVIDER_PARAM_PREFIX}.model.label`,
  description: `${PROVIDER_PARAM_PREFIX}.model.description`,
  category: "provider-specific",
  defaultValue,
})

const REGION_PARAM = (defaultValue: string): ParameterDefinition => ({
  key: "region",
  type: "text",
  label: `${PROVIDER_PARAM_PREFIX}.region.label`,
  description: `${PROVIDER_PARAM_PREFIX}.region.description`,
  category: "connection",
  defaultValue,
})

const ENDPOINT_PARAM = (defaultValue: string): ParameterDefinition => ({
  key: "endpoint",
  type: "text",
  label: `${PROVIDER_PARAM_PREFIX}.endpoint.label`,
  description: `${PROVIDER_PARAM_PREFIX}.endpoint.description`,
  category: "connection",
  defaultValue,
})

const ENABLE_TABLES_PARAM: ParameterDefinition = {
  key: "enableTables",
  type: "toggle",
  label: `${PROVIDER_PARAM_PREFIX}.enableTables.label`,
  description: `${PROVIDER_PARAM_PREFIX}.enableTables.description`,
  category: "provider-specific",
  defaultValue: true,
}

const ENABLE_FORMS_PARAM: ParameterDefinition = {
  key: "enableForms",
  type: "toggle",
  label: `${PROVIDER_PARAM_PREFIX}.enableForms.label`,
  description: `${PROVIDER_PARAM_PREFIX}.enableForms.description`,
  category: "provider-specific",
  defaultValue: false,
}

/** Discriminant for the local-http provider — picks request/response shape. */
const DIALECT_PARAM: ParameterDefinition = {
  key: "dialect",
  type: "select",
  label: `${PROVIDER_PARAM_PREFIX}.dialect.label`,
  description: `${PROVIDER_PARAM_PREFIX}.dialect.description`,
  category: "connection",
  defaultValue: "umi-ocr",
  validation: {
    options: [
      { value: "umi-ocr", label: `${PROVIDER_PARAM_PREFIX}.dialect.umi-ocr` },
      { value: "paddleocr-server", label: `${PROVIDER_PARAM_PREFIX}.dialect.paddleocr-server` },
    ],
  },
}

/**
 * Optional bearer token forwarded to the self-hosted OCR server. Stored
 * in the settings blob rather than the keyring because the endpoint is
 * intentionally user-controlled — these are LAN keys, not vendor secrets.
 */
const OPTIONAL_API_KEY_PARAM: ParameterDefinition = {
  key: "apiKey",
  type: "text",
  label: `${PROVIDER_PARAM_PREFIX}.apiKey.label`,
  description: `${PROVIDER_PARAM_PREFIX}.apiKey.description`,
  category: "connection",
  defaultValue: "",
}

const TIMEOUT_PARAM: ParameterDefinition = {
  key: "timeoutMs",
  type: "number",
  label: `${PROVIDER_PARAM_PREFIX}.timeoutMs.label`,
  description: `${PROVIDER_PARAM_PREFIX}.timeoutMs.description`,
  category: "advanced",
  defaultValue: 30000,
  validation: { min: 1000, max: 600000, step: 1000 },
}

function compose(
  providerId: string,
  providerName: string,
  extras: ParameterDefinition[]
): ProviderParameterSchema {
  return {
    providerId,
    providerName,
    parameters: [...COMMON_PARAMETERS, ...extras],
  }
}

/**
 * Per-provider parameter set. The OCR settings page renders these via the
 * shared dynamic-form helpers in `components/settings/provider/`.
 */
export const OCR_PARAMETER_SCHEMAS: Record<string, ProviderParameterSchema> = {
  "mistral-ocr": compose("mistral-ocr", "Mistral OCR", [MODEL_PARAM("mistral-ocr-2509")]),
  "google-vision": compose("google-vision", "Google Cloud Vision", [
    MODEL_PARAM("DOCUMENT_TEXT_DETECTION"),
    ENABLE_TABLES_PARAM,
  ]),
  "aws-textract": compose("aws-textract", "AWS Textract", [
    REGION_PARAM("us-east-1"),
    ENABLE_TABLES_PARAM,
    ENABLE_FORMS_PARAM,
  ]),
  "azure-document-intelligence": compose(
    "azure-document-intelligence",
    "Azure AI Document Intelligence",
    [ENDPOINT_PARAM("https://<resource>.cognitiveservices.azure.com"), MODEL_PARAM("prebuilt-read")]
  ),
  "anthropic-vision": compose("anthropic-vision", "Claude (vision)", [
    MODEL_PARAM("claude-opus-4-7"),
    PROMPT_TEMPLATE_PARAM,
  ]),
  "openai-vision": compose("openai-vision", "OpenAI (vision)", [
    MODEL_PARAM("gpt-5"),
    PROMPT_TEMPLATE_PARAM,
  ]),
  "gemini-vision": compose("gemini-vision", "Gemini (vision)", [
    MODEL_PARAM("gemini-2.5-pro"),
    PROMPT_TEMPLATE_PARAM,
  ]),
  mathpix: compose("mathpix", "Mathpix", [MODEL_PARAM("math+text")]),
  "ocr-space": compose("ocr-space", "OCR.space", [MODEL_PARAM("3")]),
  "abbyy-cloud": compose("abbyy-cloud", "ABBYY Cloud OCR", [
    MODEL_PARAM("TextExtraction_Accuracy"),
  ]),
  nanonets: compose("nanonets", "Nanonets", [MODEL_PARAM("")]),
  "lark-basic": compose("lark-basic", "Feishu / Lark", []),
  "tesseract-wasm": compose("tesseract-wasm", "Tesseract (WASM)", []),
  "tesseract-native": compose("tesseract-native", "Tesseract (native)", []),
  "windows-media-ocr": compose("windows-media-ocr", "Windows.Media.Ocr", []),
  "apple-vision": compose("apple-vision", "Apple Vision", []),
  "mlkit-android": compose("mlkit-android", "ML Kit Text Recognition", []),
  ocrs: compose("ocrs", "ocrs (local)", []),
  "paddle-ocr": compose("paddle-ocr", "PaddleOCR (local)", [MODEL_PARAM("PP-OCRv5_mobile")]),
  "local-http": compose("local-http", "Local HTTP (self-hosted)", [
    ENDPOINT_PARAM("http://localhost:1224/api/ocr"),
    DIALECT_PARAM,
    OPTIONAL_API_KEY_PARAM,
    TIMEOUT_PARAM,
  ]),
}

/** Returns the parameter schema for a provider id, or null when unknown. */
export function getOcrParameterSchema(providerId: string): ProviderParameterSchema | null {
  return OCR_PARAMETER_SCHEMAS[providerId] ?? null
}

/** Apply provider defaults over the saved config, filling any missing keys. */
export function applyOcrParameterDefaults(
  providerId: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  const schema = OCR_PARAMETER_SCHEMAS[providerId]
  if (!schema) return { ...config }
  const out: Record<string, unknown> = { ...config }
  for (const param of schema.parameters) {
    if (out[param.key] === undefined) {
      out[param.key] = param.defaultValue
    }
  }
  return out
}
