//! Bounded per-stream output capture shared by native sandbox backends.

#[cfg(any(target_os = "linux", test))]
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

pub const MAX_OUTPUT_BYTES: usize = 1_000_000;
const TRUNCATION_MARKER: &str = "\n... (truncated)";

/// Keeps captured bytes outside the drain future so cancellation preserves them.
pub(crate) struct CappedOutput<R> {
    reader: R,
    kept: Vec<u8>,
    truncated: bool,
    finished: bool,
}

impl<R> CappedOutput<R>
where
    R: AsyncRead + Unpin,
{
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader,
            kept: Vec::with_capacity(8192),
            truncated: false,
            finished: false,
        }
    }

    pub(crate) async fn drain(&mut self) {
        let mut buffer = [0_u8; 8192];
        while !self.finished {
            match self.reader.read(&mut buffer).await {
                Ok(0) => self.finished = true,
                Ok(read) => {
                    let remaining = MAX_OUTPUT_BYTES.saturating_sub(self.kept.len());
                    let take = remaining.min(read);
                    self.kept.extend_from_slice(&buffer[..take]);
                    self.truncated |= take < read;
                }
                Err(_) => self.finished = true,
            }
        }
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) async fn drain_for(&mut self, duration: Duration) {
        let _ = tokio::time::timeout(duration, self.drain()).await;
    }

    pub(crate) fn finish(self) -> (String, bool) {
        let text = String::from_utf8_lossy(&self.kept).into_owned();
        truncate_utf8(text, MAX_OUTPUT_BYTES, self.truncated || !self.finished)
    }
}

pub async fn read_capped<R>(reader: R) -> (String, bool)
where
    R: AsyncRead + Unpin,
{
    let mut output = CappedOutput::new(reader);
    output.drain().await;
    output.finish()
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
    use tokio::io::AsyncWriteExt;

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

    #[tokio::test]
    async fn canceled_drain_retains_output_and_can_resume() {
        let (mut writer, reader) = tokio::io::duplex(64);
        writer.write_all(b"before cancellation").await.unwrap();
        let mut output = CappedOutput::new(reader);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), output.drain())
                .await
                .is_err()
        );
        writer.write_all(b"; after cancellation").await.unwrap();
        drop(writer);
        output.drain().await;
        assert_eq!(
            output.finish(),
            ("before cancellation; after cancellation".into(), false)
        );
    }

    #[tokio::test]
    async fn bounded_drain_returns_with_partial_output_when_eof_stalls() {
        let (mut writer, reader) = tokio::io::duplex(64);
        writer
            .write_all(b"captured before stalled EOF")
            .await
            .unwrap();
        let mut output = CappedOutput::new(reader);
        tokio::time::timeout(
            Duration::from_secs(1),
            output.drain_for(Duration::from_millis(20)),
        )
        .await
        .expect("bounded drain must return while the writer remains open");
        let (text, truncated) = output.finish();
        assert!(truncated);
        assert_eq!(
            text,
            format!("captured before stalled EOF{TRUNCATION_MARKER}")
        );
        drop(writer);
    }

    #[tokio::test]
    async fn bounded_drain_keeps_utf8_output_within_cap() {
        let input = "界".repeat(MAX_OUTPUT_BYTES / 3 + 1);
        let (mut writer, reader) = tokio::io::duplex(input.len() + 1);
        writer.write_all(input.as_bytes()).await.unwrap();
        let mut output = CappedOutput::new(reader);
        output.drain_for(Duration::from_millis(20)).await;
        let (text, truncated) = output.finish();
        assert!(truncated);
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        assert!(text.ends_with(TRUNCATION_MARKER));
        assert!(!text.contains('\u{fffd}'));
        drop(writer);
    }
}
