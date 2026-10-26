use thiserror::Error;

#[derive(Debug, Error)]
pub enum LiteParseError {
    #[error("PDF error: {0}")]
    Pdf(#[from] pdfium::PdfiumError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("image error: {0}")]
    Image(#[from] image::ImageError),

    #[error("OCR failed: {0}")]
    Ocr(String),

    #[error("conversion error: {0}")]
    Conversion(String),

    #[error("invalid config: {0}")]
    Config(String),

    #[error("{0}")]
    Other(String),
}

impl From<String> for LiteParseError {
    fn from(s: String) -> Self {
        LiteParseError::Other(s)
    }
}

impl From<&str> for LiteParseError {
    fn from(s: &str) -> Self {
        LiteParseError::Other(s.to_string())
    }
}
