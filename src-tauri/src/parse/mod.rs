//! Native document parsing via `liteparse` (PDFium) — feature `parse-liteparse`.
//!
//! The renderer's `lib/document/parsers/native-pdf.ts` bridge calls the
//! `parse_document_native` command to get PDF text **with per-item bounding
//! boxes** (`NativeItem`), which the pdfjs path cannot provide. The command
//! is feature-gated like the `ocr-*` backends: the default build compiles a
//! stub that returns the stable `unsupported` error code so the TS layer can
//! cache the capability probe and fall back to pdfjs.
//!
//! Error contract (leading token of the error string, parsed by the TS
//! bridge): `unsupported` | `parse_failed` | `password_required` | `io`.
//!
//! IPC size note: `bytes` serializes as a JSON number array (same pattern as
//! `NativeOcrInvokePayload`). Practical limit is ~20 MB per document — larger
//! PDFs are slow over invoke; the renderer falls back to pdfjs on failure.
//!
//! OCR is intentionally disabled in the liteparse config — scanned PDFs go
//! through the existing ADR-0024 OCR subsystem, not liteparse's bundled
//! Tesseract (which we exclude via `default-features = false`).

use serde::{Deserialize, Serialize};

/// Max spatial items kept per page before the page is truncated.
// Only the feature-gated liteparse path (and tests) consume the caps —
// the default build compiles them but never calls `apply_caps`.
#[cfg_attr(not(feature = "parse-liteparse"), allow(dead_code))]
pub const PER_PAGE_ITEM_CAP: usize = 2_000;
/// Max spatial items kept across the whole document.
#[cfg_attr(not(feature = "parse-liteparse"), allow(dead_code))]
pub const DOC_ITEM_CAP: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeItem {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePage {
    pub page_number: u32,
    pub width: f32,
    pub height: f32,
    /// Page text — the TS bridge joins pages with "\n\n" to mirror the
    /// pdfjs `result.text` invariant the twin pageMap computation relies on.
    pub text: String,
    /// Empty when `truncated` is set — over-cap pages drop their items
    /// wholesale instead of shipping a misleading partial set.
    pub items: Vec<NativeItem>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeParseDto {
    pub pages: Vec<NativePage>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeParsePayload {
    /// Raw PDF bytes — serialized over IPC as a number array.
    pub bytes: Vec<u8>,
    #[serde(default)]
    pub password: Option<String>,
    /// 1-based page numbers to parse; `None` = all pages.
    #[serde(default)]
    pub target_pages: Option<Vec<u32>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    /// The `parse-liteparse` feature is not compiled in. The TS bridge
    /// caches this and stops probing.
    #[error("unsupported")]
    Unsupported,
    #[error("parse_failed: {0}")]
    ParseFailed(String),
    #[error("password_required")]
    PasswordRequired,
    #[error("io: {0}")]
    Io(String),
}

impl From<ParseError> for String {
    fn from(err: ParseError) -> String {
        err.to_string()
    }
}

/// Enforce the per-page and per-document item caps. Pure so unit tests can
/// drive it without a real parser. Pages already marked truncated keep that
/// flag; their (empty) items don't count toward the document budget.
#[cfg_attr(not(feature = "parse-liteparse"), allow(dead_code))]
pub fn apply_caps(pages: Vec<NativePage>) -> Vec<NativePage> {
    let mut doc_total: usize = 0;
    pages
        .into_iter()
        .map(|mut page| {
            let count = page.items.len();
            if count > PER_PAGE_ITEM_CAP || doc_total.saturating_add(count) > DOC_ITEM_CAP {
                page.items = Vec::new();
                page.truncated = true;
            } else {
                doc_total += count;
            }
            page
        })
        .collect()
}

#[tauri::command]
pub async fn parse_document_native(payload: NativeParsePayload) -> Result<NativeParseDto, String> {
    let _perf = crate::perf::guard("parse.document_native");
    parse_impl(payload).await.map_err(String::from)
}

#[cfg(not(feature = "parse-liteparse"))]
async fn parse_impl(_payload: NativeParsePayload) -> Result<NativeParseDto, ParseError> {
    Err(ParseError::Unsupported)
}

#[cfg(feature = "parse-liteparse")]
async fn parse_impl(payload: NativeParsePayload) -> Result<NativeParseDto, ParseError> {
    liteparse_impl::parse(payload).await
}

#[cfg(feature = "parse-liteparse")]
mod liteparse_impl {
    use super::*;
    use liteparse::types::PdfInput;
    use liteparse::{LiteParse, LiteParseConfig, LiteParseError};

    pub async fn parse(payload: NativeParsePayload) -> Result<NativeParseDto, ParseError> {
        // liteparse takes target pages as a "1,2,5-7" range string.
        let target_pages = payload
            .target_pages
            .as_ref()
            .filter(|pages| !pages.is_empty())
            .map(|pages| {
                pages
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            });
        let config = LiteParseConfig {
            // Scanned PDFs go through the ADR-0024 OCR subsystem — liteparse
            // is text-layer extraction only here (also keeps the build free
            // of liteparse's Tesseract via `default-features = false`).
            ocr_enabled: false,
            quiet: true,
            password: payload.password.clone(),
            target_pages,
            ..LiteParseConfig::default()
        };
        let result = LiteParse::new(config)
            .parse_input(PdfInput::Bytes(payload.bytes))
            .await
            .map_err(map_liteparse_error)?;

        let pages: Vec<NativePage> = result
            .pages
            .into_iter()
            .map(|page| NativePage {
                page_number: page.page_number as u32,
                width: page.page_width,
                height: page.page_height,
                text: page.text,
                items: page
                    .text_items
                    .into_iter()
                    .map(|item| NativeItem {
                        text: item.text,
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                    })
                    .collect(),
                truncated: false,
            })
            .collect();

        Ok(NativeParseDto {
            pages: apply_caps(pages),
            text: result.text,
        })
    }

    fn map_liteparse_error(err: LiteParseError) -> ParseError {
        match err {
            LiteParseError::Io(e) => ParseError::Io(e.to_string()),
            other => {
                let msg = other.to_string();
                if msg.to_ascii_lowercase().contains("password") {
                    ParseError::PasswordRequired
                } else {
                    ParseError::ParseFailed(msg)
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Minimal single-page PDF (no xref table — PDFium rebuilds it for
        /// damaged files) drawing "Hello PDF" in Helvetica. Inline because
        /// the repo has no binary-fixture convention for Rust tests.
        const MINIMAL_PDF: &[u8] = b"%PDF-1.4\n\
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n\
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n\
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n\
4 0 obj << /Length 40 >> stream\n\
BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET\n\
endstream endobj\n\
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n\
trailer << /Root 1 0 R /Size 6 >>\n\
%%EOF\n";

        #[tokio::test]
        async fn parses_a_minimal_pdf_with_spatial_items() {
            let payload = NativeParsePayload {
                bytes: MINIMAL_PDF.to_vec(),
                password: None,
                target_pages: None,
            };
            let dto = match parse(payload).await {
                Ok(dto) => dto,
                Err(ParseError::ParseFailed(msg)) if msg.to_lowercase().contains("library") => {
                    // PDFium dynamic library not loadable in this environment
                    // (e.g. CI without the build-time download) — skip rather
                    // than fail; the bundling step covers runtime placement.
                    eprintln!("skipping — PDFium not loadable: {msg}");
                    return;
                }
                Err(other) => panic!("unexpected parse error: {other:?}"),
            };
            assert_eq!(dto.pages.len(), 1);
            let page = &dto.pages[0];
            assert_eq!(page.page_number, 1);
            assert!(page.text.contains("Hello PDF"), "text: {:?}", page.text);
            assert!(!page.items.is_empty());
            assert!(!page.truncated);
            let item = &page.items[0];
            assert!(item.width > 0.0 && item.height > 0.0);
            assert!(dto.text.contains("Hello PDF"));
        }

        #[tokio::test]
        async fn invalid_bytes_map_to_parse_failed() {
            let payload = NativeParsePayload {
                bytes: vec![0x00, 0x01, 0x02],
                password: None,
                target_pages: None,
            };
            match parse(payload).await {
                Err(ParseError::ParseFailed(_)) | Err(ParseError::Io(_)) => {}
                other => panic!("expected parse_failed/io, got {other:?}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(n: u32, item_count: usize) -> NativePage {
        NativePage {
            page_number: n,
            width: 612.0,
            height: 792.0,
            text: format!("page {n} text"),
            items: (0..item_count)
                .map(|i| NativeItem {
                    text: format!("w{i}"),
                    x: 1.0,
                    y: 2.0,
                    width: 3.0,
                    height: 4.0,
                })
                .collect(),
            truncated: false,
        }
    }

    #[test]
    fn apply_caps_keeps_pages_under_the_per_page_cap() {
        let out = apply_caps(vec![page(1, 10), page(2, PER_PAGE_ITEM_CAP)]);
        assert_eq!(out[0].items.len(), 10);
        assert!(!out[0].truncated);
        assert_eq!(out[1].items.len(), PER_PAGE_ITEM_CAP);
        assert!(!out[1].truncated);
    }

    #[test]
    fn apply_caps_truncates_a_page_over_the_per_page_cap() {
        let out = apply_caps(vec![page(1, PER_PAGE_ITEM_CAP + 1)]);
        assert!(out[0].items.is_empty());
        assert!(out[0].truncated);
    }

    #[test]
    fn apply_caps_enforces_the_document_budget() {
        // 51 pages × 2000 items = 102 000 > DOC_ITEM_CAP (100 000): the 51st
        // page busts the running budget and is truncated; earlier pages keep
        // their items.
        let pages: Vec<NativePage> = (1..=51).map(|n| page(n, PER_PAGE_ITEM_CAP)).collect();
        let out = apply_caps(pages);
        assert_eq!(out[49].items.len(), PER_PAGE_ITEM_CAP);
        assert!(!out[49].truncated);
        assert!(out[50].items.is_empty());
        assert!(out[50].truncated);
    }

    #[test]
    fn apply_caps_truncated_page_does_not_consume_budget() {
        // Page 1 is over the per-page cap (dropped); page 2 must still fit
        // because page 1's items never counted toward the document budget.
        let out = apply_caps(vec![page(1, PER_PAGE_ITEM_CAP + 5), page(2, 100)]);
        assert!(out[0].truncated);
        assert_eq!(out[1].items.len(), 100);
        assert!(!out[1].truncated);
    }

    #[test]
    fn error_codes_are_stable_strings() {
        assert_eq!(String::from(ParseError::Unsupported), "unsupported");
        assert_eq!(
            String::from(ParseError::ParseFailed("boom".into())),
            "parse_failed: boom"
        );
        assert_eq!(String::from(ParseError::PasswordRequired), "password_required");
        assert_eq!(String::from(ParseError::Io("disk".into())), "io: disk");
    }

    #[test]
    fn dto_serializes_camel_case() {
        let dto = NativeParseDto {
            pages: vec![page(1, 1)],
            text: "hello".to_string(),
        };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"pageNumber\":1"));
        assert!(json.contains("\"truncated\":false"));
        assert!(json.contains("\"items\":[{"));
        let parsed: NativeParseDto = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.pages[0].page_number, 1);
        assert_eq!(parsed.text, "hello");
    }

    #[test]
    fn payload_deserializes_camel_case_with_optional_fields() {
        let parsed: NativeParsePayload =
            serde_json::from_str(r#"{"bytes":[1,2,3],"targetPages":[1,2]}"#).unwrap();
        assert_eq!(parsed.bytes, vec![1, 2, 3]);
        assert_eq!(parsed.password, None);
        assert_eq!(parsed.target_pages, Some(vec![1, 2]));
    }

    #[cfg(not(feature = "parse-liteparse"))]
    #[tokio::test]
    async fn command_reports_unsupported_without_the_feature() {
        let payload = NativeParsePayload {
            bytes: vec![1, 2, 3],
            password: None,
            target_pages: None,
        };
        let err = parse_document_native(payload).await.unwrap_err();
        assert_eq!(err, "unsupported");
    }
}
