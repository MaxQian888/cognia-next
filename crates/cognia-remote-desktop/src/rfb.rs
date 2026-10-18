//! The `vnc` Host handshake adapter (ADR-0234 §4).
//!
//! The Host completes the RFB handshake and VNC authentication with the
//! server, then presents the viewer with an already-authenticated stream that
//! offers only security type None. The password never reaches the renderer or
//! a plugin. After both halves finish, the bytes from ClientInit onward are
//! piped unchanged: those messages are identical in RFB 3.3, 3.7 and 3.8.
//!
//! Supported server security types are None (1) and VncAuth (2), a user
//! decision for Phase 2. Anything else is refused with the offered numbers.

use crate::error::{RemoteDesktopError, Result};
use des::cipher::{BlockCipherEncrypt, KeyInit};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const SECURITY_NONE: u8 = 1;
pub const SECURITY_VNC_AUTH: u8 = 2;
const MAX_REASON_BYTES: u32 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Version {
    V3_3,
    V3_7,
    V3_8,
}

impl Version {
    fn banner(self) -> &'static [u8; 12] {
        match self {
            Version::V3_3 => b"RFB 003.003\n",
            Version::V3_7 => b"RFB 003.007\n",
            Version::V3_8 => b"RFB 003.008\n",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Version::V3_3 => "3.3",
            Version::V3_7 => "3.7",
            Version::V3_8 => "3.8",
        }
    }
}

/// Parse a 12-byte ProtocolVersion. Unknown minors below 7 are 3.3 and above
/// 8 are 3.8 (RFC 6143 §7.1.1; Apple Screen Sharing sends 003.889).
pub fn parse_version(banner: &[u8; 12]) -> Result<Version> {
    let invalid = || RemoteDesktopError::new("remote_desktop_protocol_invalid");
    if &banner[..4] != b"RFB " || banner[7] != b'.' || banner[11] != b'\n' {
        return Err(invalid());
    }
    let digits = |range: std::ops::Range<usize>| -> Result<u32> {
        std::str::from_utf8(&banner[range])
            .ok()
            .filter(|s| s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse().ok())
            .ok_or_else(invalid)
    };
    if digits(4..7)? != 3 {
        return Err(RemoteDesktopError::with_detail(
            "remote_desktop_protocol_unsupported",
            String::from_utf8_lossy(&banner[..11]).into_owned(),
        ));
    }
    Ok(match digits(8..11)? {
        0..=6 => Version::V3_3,
        7 => Version::V3_7,
        _ => Version::V3_8,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub protocol_version: &'static str,
    pub security_types: Vec<u8>,
    /// The Host can authenticate to this server with what it supports.
    pub supported: bool,
    /// VncAuth is the only supported type on offer.
    pub requires_password: bool,
}

async fn read_reason<S: AsyncRead + Unpin>(stream: &mut S) -> Result<String> {
    let len = stream.read_u32().await.map_err(io_error)?;
    if len > MAX_REASON_BYTES {
        return Err(RemoteDesktopError::new("remote_desktop_protocol_invalid"));
    }
    let mut bytes = vec![0; len as usize];
    stream.read_exact(&mut bytes).await.map_err(io_error)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn io_error(_: std::io::Error) -> RemoteDesktopError {
    RemoteDesktopError::new("remote_desktop_connection_lost")
}

async fn read_banner<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Version> {
    let mut banner = [0; 12];
    stream.read_exact(&mut banner).await.map_err(io_error)?;
    parse_version(&banner)
}

/// Read the server's offered security types. Version 3.3 servers choose one.
async fn read_security_types<S: AsyncRead + Unpin>(
    stream: &mut S,
    version: Version,
) -> Result<Vec<u8>> {
    if version == Version::V3_3 {
        let chosen = stream.read_u32().await.map_err(io_error)?;
        if chosen == 0 {
            let reason = read_reason(stream).await?;
            return Err(RemoteDesktopError::with_detail("remote_desktop_server_refused", reason));
        }
        return Ok(vec![u8::try_from(chosen).unwrap_or(u8::MAX)]);
    }
    let count = stream.read_u8().await.map_err(io_error)?;
    if count == 0 {
        let reason = read_reason(stream).await?;
        return Err(RemoteDesktopError::with_detail("remote_desktop_server_refused", reason));
    }
    let mut types = vec![0; count as usize];
    stream.read_exact(&mut types).await.map_err(io_error)?;
    Ok(types)
}

fn unsupported(types: &[u8]) -> RemoteDesktopError {
    let list = types
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(",");
    RemoteDesktopError::with_detail("remote_desktop_security_unsupported", list)
}

/// Choose a security type the Host can complete. A stored password is not
/// required when the server offers None.
pub fn choose_security(types: &[u8], password: Option<&str>) -> Result<u8> {
    if password.is_some() && types.contains(&SECURITY_VNC_AUTH) {
        Ok(SECURITY_VNC_AUTH)
    } else if types.contains(&SECURITY_NONE) {
        Ok(SECURITY_NONE)
    } else if types.contains(&SECURITY_VNC_AUTH) {
        Err(RemoteDesktopError::new("remote_desktop_credential_required"))
    } else {
        Err(unsupported(types))
    }
}

/// VncAuth response: DES-ECB over the 16-byte challenge, keyed with the first
/// eight password bytes (zero-padded), each byte's bits reversed.
pub fn vnc_auth_response(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    let mut key = [0u8; 8];
    for (slot, byte) in key.iter_mut().zip(password.as_bytes()) {
        *slot = byte.reverse_bits();
    }
    let cipher = des::Des::new(&key.into());
    let mut response = *challenge;
    for chunk in response.chunks_exact_mut(8) {
        let block: &mut [u8; 8] = chunk.try_into().expect("8-byte chunk");
        cipher.encrypt_block(block.into());
    }
    key.fill(0);
    response
}

/// Read the server's version and security offer, then disconnect without
/// authenticating.
pub async fn probe<S: AsyncRead + AsyncWrite + Unpin>(server: &mut S) -> Result<ProbeResult> {
    let version = read_banner(server).await?;
    server
        .write_all(version.banner())
        .await
        .map_err(io_error)?;
    let types = read_security_types(server, version).await?;
    let supported = types.contains(&SECURITY_NONE) || types.contains(&SECURITY_VNC_AUTH);
    Ok(ProbeResult {
        protocol_version: version.label(),
        requires_password: supported && !types.contains(&SECURITY_NONE),
        security_types: types,
        supported,
    })
}

/// Complete the handshake and authentication with the server.
pub async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    server: &mut S,
    password: Option<&str>,
) -> Result<Version> {
    let version = read_banner(server).await?;
    server
        .write_all(version.banner())
        .await
        .map_err(io_error)?;
    let types = read_security_types(server, version).await?;
    let chosen = choose_security(&types, password)?;
    if version != Version::V3_3 {
        server.write_u8(chosen).await.map_err(io_error)?;
    }
    if chosen == SECURITY_VNC_AUTH {
        let mut challenge = [0; 16];
        server.read_exact(&mut challenge).await.map_err(io_error)?;
        let response = vnc_auth_response(password.expect("chosen only with a password"), &challenge);
        server.write_all(&response).await.map_err(io_error)?;
    }
    let has_result = version == Version::V3_8 || chosen == SECURITY_VNC_AUTH;
    if has_result {
        let status = server.read_u32().await.map_err(io_error)?;
        if status != 0 {
            return Err(if version == Version::V3_8 {
                RemoteDesktopError::with_detail("remote_desktop_auth_failed", read_reason(server).await?)
            } else {
                RemoteDesktopError::new("remote_desktop_auth_failed")
            });
        }
    }
    server.flush().await.map_err(io_error)?;
    Ok(version)
}

/// Play the server toward the viewer: announce 3.8, accept the viewer's
/// version, offer only None and report success where the version requires.
pub async fn present_authenticated<C: AsyncRead + AsyncWrite + Unpin>(client: &mut C) -> Result<Version> {
    client
        .write_all(Version::V3_8.banner())
        .await
        .map_err(io_error)?;
    let version = read_banner(client).await?;
    match version {
        Version::V3_3 => {
            client
                .write_u32(u32::from(SECURITY_NONE))
                .await
                .map_err(io_error)?;
        }
        Version::V3_7 | Version::V3_8 => {
            client
                .write_all(&[1, SECURITY_NONE])
                .await
                .map_err(io_error)?;
            let chosen = client.read_u8().await.map_err(io_error)?;
            if chosen != SECURITY_NONE {
                return Err(RemoteDesktopError::new("remote_desktop_protocol_invalid"));
            }
            if version == Version::V3_8 {
                client.write_u32(0).await.map_err(io_error)?;
            }
        }
    }
    client.flush().await.map_err(io_error)?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[test]
    fn versions_parse_per_rfc_6143() {
        assert_eq!(parse_version(b"RFB 003.003\n").unwrap(), Version::V3_3);
        assert_eq!(parse_version(b"RFB 003.005\n").unwrap(), Version::V3_3);
        assert_eq!(parse_version(b"RFB 003.007\n").unwrap(), Version::V3_7);
        assert_eq!(parse_version(b"RFB 003.008\n").unwrap(), Version::V3_8);
        assert_eq!(parse_version(b"RFB 003.889\n").unwrap(), Version::V3_8);
        assert_eq!(
            parse_version(b"RFB 004.001\n").unwrap_err().code,
            "remote_desktop_protocol_unsupported"
        );
        assert_eq!(
            parse_version(b"HTTP/1.1 200").unwrap_err().code,
            "remote_desktop_protocol_invalid"
        );
        assert_eq!(
            parse_version(b"RFB 0x3.008\n").unwrap_err().code,
            "remote_desktop_protocol_invalid"
        );
    }

    #[test]
    fn vnc_auth_matches_an_independent_des_computation() {
        // openssl enc -des-ecb -K 0e86ceceeef64e26 -nopad over "0123456789abcdef"
        // (the key is "password" with every byte's bits reversed).
        let response = vnc_auth_response("password", b"0123456789abcdef");
        assert_eq!(hex::encode(response), "5645abeb5f1e6475e8feb11beb66ea19");
        // Only the first eight bytes key the cipher.
        assert_eq!(
            vnc_auth_response("password-and-more", b"0123456789abcdef"),
            response
        );
    }

    #[test]
    fn security_choice_prefers_auth_with_a_password_and_names_unsupported_types() {
        assert_eq!(choose_security(&[1, 2], Some("pw")).unwrap(), SECURITY_VNC_AUTH);
        assert_eq!(choose_security(&[1, 2], None).unwrap(), SECURITY_NONE);
        assert_eq!(choose_security(&[1], Some("pw")).unwrap(), SECURITY_NONE);
        assert_eq!(
            choose_security(&[2], None).unwrap_err().code,
            "remote_desktop_credential_required"
        );
        let error = choose_security(&[19, 30], Some("pw")).unwrap_err();
        assert_eq!(error.code, "remote_desktop_security_unsupported");
        assert_eq!(error.detail.as_deref(), Some("19,30"));
    }

    /// A scripted server half: writes `send`, expects to read exactly `expect`.
    async fn scripted_server(
        mut stream: tokio::io::DuplexStream,
        steps: Vec<(Vec<u8>, usize)>,
    ) -> Vec<Vec<u8>> {
        let mut received = Vec::new();
        for (send, read) in steps {
            stream.write_all(&send).await.unwrap();
            let mut buf = vec![0; read];
            stream.read_exact(&mut buf).await.unwrap();
            received.push(buf);
        }
        received
    }

    #[tokio::test]
    async fn authenticates_with_vnc_auth_on_3_8() {
        let (mut host, server) = duplex(1024);
        let script = tokio::spawn(scripted_server(
            server,
            vec![
                (b"RFB 003.008\n".to_vec(), 12),
                (vec![2, 2, 1], 1),
                (b"0123456789abcdef".to_vec(), 16),
                (0u32.to_be_bytes().to_vec(), 0),
            ],
        ));
        assert_eq!(authenticate(&mut host, Some("password")).await.unwrap(), Version::V3_8);
        let received = script.await.unwrap();
        assert_eq!(received[0], b"RFB 003.008\n");
        assert_eq!(received[1], [SECURITY_VNC_AUTH]);
        assert_eq!(hex::encode(&received[2]), "5645abeb5f1e6475e8feb11beb66ea19");
    }

    #[tokio::test]
    async fn surfaces_a_3_8_failure_reason_and_3_3_failures_without_one() {
        let (mut host, server) = duplex(1024);
        let mut failure = 1u32.to_be_bytes().to_vec();
        failure.extend(7u32.to_be_bytes());
        failure.extend(b"bad pw!");
        tokio::spawn(scripted_server(
            server,
            vec![
                (b"RFB 003.008\n".to_vec(), 12),
                (vec![1, 2], 1),
                (b"0123456789abcdef".to_vec(), 16),
                (failure, 0),
            ],
        ));
        let error = authenticate(&mut host, Some("password")).await.unwrap_err();
        assert_eq!(error.code, "remote_desktop_auth_failed");
        assert_eq!(error.detail.as_deref(), Some("bad pw!"));

        let (mut host, server) = duplex(1024);
        tokio::spawn(scripted_server(
            server,
            vec![
                (b"RFB 003.003\n".to_vec(), 12),
                (2u32.to_be_bytes().to_vec(), 0),
                (b"0123456789abcdef".to_vec(), 16),
                (1u32.to_be_bytes().to_vec(), 0),
            ],
        ));
        let error = authenticate(&mut host, Some("password")).await.unwrap_err();
        assert_eq!((error.code, error.detail), ("remote_desktop_auth_failed", None));
    }

    #[tokio::test]
    async fn none_security_on_3_7_has_no_security_result() {
        let (mut host, server) = duplex(1024);
        let script = tokio::spawn(scripted_server(
            server,
            vec![(b"RFB 003.007\n".to_vec(), 12), (vec![1, 1], 1)],
        ));
        assert_eq!(authenticate(&mut host, None).await.unwrap(), Version::V3_7);
        assert_eq!(script.await.unwrap()[1], [SECURITY_NONE]);
    }

    #[tokio::test]
    async fn a_server_refusal_and_an_oversized_reason_are_reported() {
        let (mut host, server) = duplex(1024);
        let mut refusal = vec![0u8];
        refusal.extend(4u32.to_be_bytes());
        refusal.extend(b"busy");
        tokio::spawn(scripted_server(
            server,
            vec![(b"RFB 003.008\n".to_vec(), 12), (refusal, 0)],
        ));
        let error = authenticate(&mut host, None).await.unwrap_err();
        assert_eq!((error.code, error.detail.as_deref()), ("remote_desktop_server_refused", Some("busy")));

        let (mut host, server) = duplex(1024);
        let mut huge = vec![0u8];
        huge.extend((MAX_REASON_BYTES + 1).to_be_bytes());
        tokio::spawn(scripted_server(server, vec![(b"RFB 003.008\n".to_vec(), 12), (huge, 0)]));
        assert_eq!(
            authenticate(&mut host, None).await.unwrap_err().code,
            "remote_desktop_protocol_invalid"
        );
    }

    #[tokio::test]
    async fn probe_reads_the_offer_without_authenticating() {
        let (mut host, server) = duplex(1024);
        let script = tokio::spawn(scripted_server(
            server,
            vec![(b"RFB 003.889\n".to_vec(), 12), (vec![3, 30, 2, 5], 0)],
        ));
        let result = probe(&mut host).await.unwrap();
        assert_eq!(
            result,
            ProbeResult {
                protocol_version: "3.8",
                security_types: vec![30, 2, 5],
                supported: true,
                requires_password: true,
            }
        );
        // The Host answered with its own banner and sent nothing else.
        assert_eq!(script.await.unwrap()[0], b"RFB 003.008\n");
        let mut host_end = host;
        let mut rest = Vec::new();
        drop(host_end.shutdown().await);
        let _ = host_end.read_to_end(&mut rest).await;
        assert!(rest.is_empty());
    }

    #[tokio::test]
    async fn presents_none_to_a_3_8_and_a_3_3_viewer() {
        let (mut host, mut viewer) = duplex(1024);
        let task = tokio::spawn(async move { present_authenticated(&mut host).await });
        let mut banner = [0; 12];
        viewer.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"RFB 003.008\n");
        viewer.write_all(b"RFB 003.008\n").await.unwrap();
        let mut offer = [0; 2];
        viewer.read_exact(&mut offer).await.unwrap();
        assert_eq!(offer, [1, SECURITY_NONE]);
        viewer.write_u8(SECURITY_NONE).await.unwrap();
        assert_eq!(viewer.read_u32().await.unwrap(), 0);
        assert_eq!(task.await.unwrap().unwrap(), Version::V3_8);

        let (mut host, mut viewer) = duplex(1024);
        let task = tokio::spawn(async move { present_authenticated(&mut host).await });
        viewer.read_exact(&mut banner).await.unwrap();
        viewer.write_all(b"RFB 003.003\n").await.unwrap();
        assert_eq!(viewer.read_u32().await.unwrap(), u32::from(SECURITY_NONE));
        assert_eq!(task.await.unwrap().unwrap(), Version::V3_3);
    }

    #[tokio::test]
    async fn a_viewer_choosing_another_type_is_refused() {
        let (mut host, mut viewer) = duplex(1024);
        let task = tokio::spawn(async move { present_authenticated(&mut host).await });
        let mut banner = [0; 12];
        viewer.read_exact(&mut banner).await.unwrap();
        viewer.write_all(b"RFB 003.008\n").await.unwrap();
        let mut offer = [0; 2];
        viewer.read_exact(&mut offer).await.unwrap();
        viewer.write_u8(SECURITY_VNC_AUTH).await.unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().code,
            "remote_desktop_protocol_invalid"
        );
    }
}
