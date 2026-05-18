/**
 * AWS Textract OCR provider.
 *
 * Endpoint: POST https://textract.<region>.amazonaws.com/
 *   X-Amz-Target: Textract.DetectDocumentText
 *              or Textract.AnalyzeDocument (with FeatureTypes: ["TABLES","FORMS"])
 *   Content-Type: application/x-amz-json-1.1
 *   Body: { Document: { Bytes: "<base64>" } }
 *   Auth: AWS Signature V4 (see `_sigv4.ts`).
 *
 * Returns plain text from LINE-type blocks plus structured paragraphs with
 * bounding boxes + confidence values.
 */

import { bytesToBase64, normalizeImage } from "../image-prep"
import {
  OcrError,
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "../types"
import { cloudFetch, defaultErrorCodeFor, parseJson, requireSecret } from "./_http"
import { signRequest } from "./_sigv4"

export interface AwsTextractConfig {
  region?: string
  endpoint?: string
  enableTables?: boolean
  enableForms?: boolean
  /** Override timestamp for deterministic tests. */
  now?: Date
  fetchImpl?: typeof fetch
}

interface TextractGeometry {
  BoundingBox?: { Width?: number; Height?: number; Left?: number; Top?: number }
}
interface TextractBlock {
  BlockType?: string
  Text?: string
  Confidence?: number
  Geometry?: TextractGeometry
  Page?: number
}
interface TextractResponse {
  Blocks?: TextractBlock[]
  DocumentMetadata?: { Pages?: number }
  __type?: string
  Message?: string
  message?: string
}

export function buildAwsTextractProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "aws-textract",
    label: "AWS Textract",
    category: "document-cloud",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["accessKeyId", "secretAccessKey", "sessionToken"],
    async extract(input, ctx) {
      return awsTextractExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function awsTextractExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const accessKeyId = requireSecret("aws-textract", ctx.credentials.secrets, "accessKeyId")
  const secretAccessKey = requireSecret("aws-textract", ctx.credentials.secrets, "secretAccessKey")
  const sessionToken = ctx.credentials.secrets["sessionToken"]

  const config = (ctx.config ?? {}) as AwsTextractConfig
  const region = config.region ?? "us-east-1"
  const endpoint = config.endpoint ?? `https://textract.${region}.amazonaws.com/`
  const enableTables = config.enableTables !== false
  const enableForms = config.enableForms === true
  const useAnalyze = enableTables || enableForms

  const normalized = await normalizeImage(input.source)
  if (normalized.mimeType.startsWith("application/pdf")) {
    throw new OcrError(
      "invalid_input",
      "aws-textract",
      "AWS Textract sync API requires images. Convert PDFs to PNG pages first."
    )
  }
  const base64 = bytesToBase64(normalized.bytes)
  const body: Record<string, unknown> = { Document: { Bytes: base64 } }
  if (useAnalyze) {
    const features: string[] = []
    if (enableTables) features.push("TABLES")
    if (enableForms) features.push("FORMS")
    body.FeatureTypes = features
  }
  const action = useAnalyze ? "Textract.AnalyzeDocument" : "Textract.DetectDocumentText"
  const bodyStr = JSON.stringify(body)
  const signed = await signRequest(
    { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined },
    {
      method: "POST",
      service: "textract",
      region,
      url: endpoint,
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": action,
      },
      body: bodyStr,
      now: config.now,
    }
  )

  const start = Date.now()
  const res = await cloudFetch({
    providerId: "aws-textract",
    url: signed.url,
    headers: signed.headers,
    body: bodyStr,
    signal: ctx.signal,
    fetchImpl: fetchImpl ?? config.fetchImpl,
    errorCodeFor: (status) => {
      // Textract uses 400 with __type=ThrottlingException for rate-limit.
      if (status === 400) return "invalid_input"
      return defaultErrorCodeFor(status)
    },
  })
  const data = parseJson<TextractResponse>("aws-textract", res.body)

  if (data.__type) {
    const code = mapTextractException(data.__type)
    throw new OcrError(code, "aws-textract", data.Message || data.message || data.__type)
  }

  const totalPages = data.DocumentMetadata?.Pages ?? 1
  const blocksByPage: Record<number, OcrBlock[]> = {}
  const textByPage: Record<number, string[]> = {}
  for (const block of data.Blocks ?? []) {
    if (block.BlockType !== "LINE") continue
    const pageNumber = block.Page ?? 1
    const text = block.Text ?? ""
    if (!blocksByPage[pageNumber]) blocksByPage[pageNumber] = []
    if (!textByPage[pageNumber]) textByPage[pageNumber] = []
    blocksByPage[pageNumber].push({
      text,
      bbox: geometryToBox(block.Geometry),
      confidence: block.Confidence ? block.Confidence / 100 : undefined,
      kind: "line",
    })
    textByPage[pageNumber].push(text)
  }

  const pages = Array.from({ length: totalPages }, (_unused, i) => {
    const pageNumber = i + 1
    const lines = textByPage[pageNumber] ?? []
    const text = lines.join("\n")
    return {
      pageNumber,
      markdown: text,
      text,
      blocks: blocksByPage[pageNumber] ?? [],
    }
  })

  return {
    providerId: "aws-textract",
    pages,
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

function geometryToBox(geom: TextractGeometry | undefined): OcrBlock["bbox"] | undefined {
  if (!geom?.BoundingBox) return undefined
  const { Left = 0, Top = 0, Width = 0, Height = 0 } = geom.BoundingBox
  return { x: Left, y: Top, width: Width, height: Height }
}

function mapTextractException(typeStr: string): OcrError["code"] {
  const lower = typeStr.toLowerCase()
  if (lower.includes("throttling") || lower.includes("provisionedthroughput")) {
    return "rate_limited"
  }
  if (
    lower.includes("invalidsignature") ||
    lower.includes("accessdenied") ||
    lower.includes("auth")
  ) {
    return "missing_credentials"
  }
  if (lower.includes("unsupporteddocument") || lower.includes("invalidparameter")) {
    return "invalid_input"
  }
  return "provider_failed"
}

export const awsTextractProvider = buildAwsTextractProvider()
