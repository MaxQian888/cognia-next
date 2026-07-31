//! Shared resource ceilings for untrusted plugin downloads and archives.

use std::io::{Read, Write};

use futures_util::StreamExt as _;

/// Maximum compressed payload accepted from a remote plugin source.
pub(crate) const MAX_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;
/// Maximum cumulative regular-file bytes written while extracting a plugin.
pub(crate) const MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;
/// Maximum archive entries, including directories.
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 20_000;
/// Small detached-signature responses never need to exceed this ceiling.
pub(crate) const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;
/// Registry and source-control metadata responses are small JSON documents.
pub(crate) const MAX_METADATA_BYTES: u64 = 1024 * 1024;

pub(crate) async fn read_response_limited(
    response: reqwest::Response,
    limit: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!("{label} exceeds the {limit}-byte download limit"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("read {label} body: {error}"))?;
        let next_len = (bytes.len() as u64)
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("{label} size overflow"))?;
        if next_len > limit {
            return Err(format!("{label} exceeds the {limit}-byte download limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) fn copy_with_budget<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total_written: &mut u64,
    limit: u64,
    label: &str,
) -> Result<(), String> {
    let remaining = limit.saturating_sub(*total_written);
    let written = {
        let mut limited = reader.take(remaining);
        std::io::copy(&mut limited, writer).map_err(|error| format!("extract {label}: {error}"))?
    };
    *total_written = total_written
        .checked_add(written)
        .ok_or_else(|| "plugin archive extraction size overflow".to_string())?;
    let mut probe = [0_u8; 1];
    if written == remaining
        && reader
            .read(&mut probe)
            .map_err(|error| format!("extract {label}: {error}"))?
            != 0
    {
        return Err(format!(
            "plugin archive expands past the {limit}-byte extraction limit"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn response_from(raw_response: &'static [u8]) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket.write_all(raw_response).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        reqwest::get(format!("http://{address}")).await.unwrap()
    }

    #[tokio::test]
    async fn response_limit_rejects_an_oversized_content_length() {
        let response =
            response_from(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n123456789").await;
        let error = read_response_limited(response, 8, "fixture")
            .await
            .unwrap_err();
        assert!(error.contains("8-byte download limit"));
    }

    #[tokio::test]
    async fn response_limit_rejects_an_oversized_chunked_body() {
        let response = response_from(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n",
        )
        .await;
        let error = read_response_limited(response, 8, "fixture")
            .await
            .unwrap_err();
        assert!(error.contains("8-byte download limit"));
    }

    #[test]
    fn copy_budget_rejects_the_first_byte_past_the_limit() {
        let mut input = std::io::Cursor::new(vec![1_u8; 9]);
        let mut output = Vec::new();
        let mut total = 0;
        let error =
            copy_with_budget(&mut input, &mut output, &mut total, 8, "fixture").unwrap_err();
        assert!(error.contains("8-byte extraction limit"));
        assert_eq!(total, 8);
    }

    #[test]
    fn copy_budget_is_cumulative_across_entries() {
        let mut total = 0;
        let mut output = Vec::new();
        copy_with_budget(
            &mut std::io::Cursor::new(vec![1_u8; 4]),
            &mut output,
            &mut total,
            8,
            "first",
        )
        .unwrap();
        assert!(copy_with_budget(
            &mut std::io::Cursor::new(vec![2_u8; 5]),
            &mut output,
            &mut total,
            8,
            "second",
        )
        .is_err());
    }
}
