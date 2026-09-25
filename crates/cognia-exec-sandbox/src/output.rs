//! Bounded per-stream output capture shared by native sandbox backends.

use tokio::io::{AsyncRead, AsyncReadExt};

pub const MAX_OUTPUT_BYTES: usize = 1_000_000;
const TRUNCATION_MARKER: &str = "\n... (truncated)";

pub async fn read_capped<R>(mut reader: R) -> (String, bool)
where
    R: AsyncRead + Unpin,
{
    let mut kept = Vec::with_capacity(8192);
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                let take = remaining.min(read);
                kept.extend_from_slice(&buffer[..take]);
                truncated |= take < read;
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&kept).into_owned();
    truncate_utf8(text, MAX_OUTPUT_BYTES, truncated)
}

pub fn truncate_utf8(text: String, cap: usize, already_truncated: bool) -> (String, bool) {
    if !already_truncated && text.len() <= cap {
        return (text, false);
    }
    let content_cap = cap.saturating_sub(TRUNCATION_MARKER.len());
    let mut end = content_cap.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut output = text[..end].to_string();
    output.push_str(TRUNCATION_MARKER);
    (output, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_on_a_utf8_boundary_within_the_cap() {
        let (text, truncated) = truncate_utf8("界".repeat(400_000), MAX_OUTPUT_BYTES, false);
        assert!(truncated);
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        assert!(text.ends_with(TRUNCATION_MARKER));
        assert!(text.is_char_boundary(text.len()));
    }

    #[tokio::test]
    async fn drains_and_caps_an_async_stream() {
        let input = "é".repeat(600_000);
        let (mut writer, reader) = tokio::io::duplex(input.len() + 1);
        let write = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer.write_all(input.as_bytes()).await.unwrap();
        });
        let (text, truncated) = read_capped(reader).await;
        write.await.unwrap();
        assert!(truncated);
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        assert!(text.ends_with(TRUNCATION_MARKER));
    }
}
