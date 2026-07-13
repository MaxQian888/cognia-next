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
import { OcrError } from "@/lib/ocr/errors"
import {
  type OcrBlock,
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "@/types/ocr"
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
}

/**
 * Sync-API document size limit (10 MB) for DetectDocumentText / AnalyzeDocument.
 * https://docs.aws.amazon.com/textract/latest/dg/limits-document.html
 */
const TEXTRACT_SYNC_MAX_BYTES = 10 * 1024 * 1024

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
  if (normalized.bytes.length > TEXTRACT_SYNC_MAX_BYTES) {
    throw new OcrError(
      "invalid_input",
      "aws-textract",
      `Document is ${normalized.bytes.length} bytes; the AWS Textract sync API accepts at most 10 MB. Downscale or compress the image first.`
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
    // AWS errors always come with a non-2xx status; the error body carries the
    // real kind in `__type` (e.g. ProvisionedThroughputExceededException on
    // HTTP 400, ThrottlingException on HTTP 500), so classify by body first
    // and only fall back to the HTTP status.
    errorCodeFor: textractErrorCodeFor,
  })
  const data = parseJson<TextractResponse>("aws-textract", res.body)

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

/**
 * Classify a Textract error response. AWS json-1.1 error bodies look like
 * `{"__type":"com.amazonaws.textract#ThrottlingException","Message":"..."}`
 * (the namespace prefix is optional), and the HTTP status alone is misleading:
 * ThrottlingException arrives as HTTP 500 and ProvisionedThroughputExceeded /
 * AccessDenied as HTTP 400. Parse `__type` first; fall back to the status.
 */
export function textractErrorCodeFor(status: number, bodyText?: string): OcrError["code"] {
  const exceptionType = extractExceptionType(bodyText)
  if (exceptionType) {
    const mapped = mapTextractException(exceptionType)
    if (mapped) return mapped
  }
  return defaultErrorCodeFor(status)
}

function extractExceptionType(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { __type?: unknown }
    if (typeof parsed.__type !== "string" || parsed.__type.length === 0) return undefined
    // Strip the "com.amazonaws.textract#" namespace prefix when present.
    const hashIndex = parsed.__type.lastIndexOf("#")
    return hashIndex >= 0 ? parsed.__type.slice(hashIndex + 1) : parsed.__type
  } catch {
    return undefined
  }
}

function mapTextractException(typeStr: string): OcrError["code"] | undefined {
  const lower = typeStr.toLowerCase()
  if (
    lower.includes("throttling") ||
    lower.includes("provisionedthroughput") ||
    lower.includes("limitexceeded")
  ) {
    return "rate_limited"
  }
  if (
    lower.includes("accessdenied") ||
    lower.includes("unrecognizedclient") ||
    lower.includes("invalidsignature") ||
    lower.includes("expiredtoken") ||
    lower.includes("auth")
  ) {
    return "missing_credentials"
  }
  if (
    lower.includes("unsupporteddocument") ||
    lower.includes("documenttoolarge") ||
    lower.includes("baddocument") ||
    lower.includes("invalidparameter")
  ) {
    return "invalid_input"
  }
  return undefined
}

export const awsTextractProvider = buildAwsTextractProvider()
