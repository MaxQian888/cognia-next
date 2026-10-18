//! External-app launchers (ADR-0234 Phase 5). A closed list: a plugin names
//! one, it never supplies a URI. Today only RustDesk, opened as
//! `rustdesk://connection/new/<id>[@<server>][?key=<key>]`.
//!
//! That form is the one every RustDesk version accepts
//! (`urlLinkToCmdArgs`, `flutter/lib/common.dart`), and it keeps the ID's
//! case because the ID sits in the path, not the host. Cognia never builds
//! `rustdesk://config/…` or `rustdesk://password/…` (both change settings on
//! mobile) and never puts a password in the URI. Every client re-parses the
//! URI with [`parse_rustdesk_uri`] before opening it.

use crate::error::{RemoteDesktopError, Result};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};

pub const RUSTDESK_URI_PREFIX: &str = "rustdesk://connection/new/";
const MAX_KEY_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Launcher {
    Rustdesk,
}

impl Launcher {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rustdesk => "rustdesk",
        }
    }
}

/// What an external-app binding stores. No password, ever.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppLaunch {
    pub launcher: Launcher,
    /// The RustDesk ID, without the spaces the client shows it with.
    pub peer_id: String,
    /// A self-hosted ID server, `host[:port]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    /// The self-hosted server's public key. Not a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

fn valid_peer_id(id: &str) -> bool {
    let mut chars = id.chars();
    (6..=32).contains(&id.len())
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn valid_port(port: &str) -> bool {
    !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()) && port.parse::<u16>().is_ok_and(|p| p > 0)
}

/// `host`, `host:port`, `a.b.c.d[:port]` or `[v6][:port]`.
fn valid_server(server: &str) -> bool {
    if let Some(rest) = server.strip_prefix('[') {
        let Some((ip, after)) = rest.split_once(']') else {
            return false;
        };
        return ip.parse::<Ipv6Addr>().is_ok() && (after.is_empty() || after.strip_prefix(':').is_some_and(valid_port));
    }
    let (host, port) = match server.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (server, None),
    };
    port.is_none_or(valid_port)
        && (host.parse::<Ipv4Addr>().is_ok() || cognia_net::egress::is_valid_hostname(host))
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
}

fn optional(value: &Option<String>) -> Option<String> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
}

/// Check and normalize what a user typed: spaces leave the ID, empty
/// optionals become absent.
pub fn normalize(launch: &AppLaunch) -> Result<AppLaunch> {
    let peer_id: String = launch.peer_id.chars().filter(|c| !c.is_whitespace()).collect();
    if !valid_peer_id(&peer_id) {
        return Err(RemoteDesktopError::new("remote_desktop_launch_peer_invalid"));
    }
    let server = optional(&launch.server);
    if server.as_deref().is_some_and(|server| !valid_server(server)) {
        return Err(RemoteDesktopError::new("remote_desktop_launch_server_invalid"));
    }
    let key = optional(&launch.key);
    if key.as_deref().is_some_and(|key| !valid_key(key)) {
        return Err(RemoteDesktopError::new("remote_desktop_launch_key_invalid"));
    }
    Ok(AppLaunch {
        launcher: launch.launcher,
        peer_id,
        server,
        key,
    })
}

/// The key goes in a query RustDesk reads with Dart's decoder, which turns
/// `+` into a space: every non-alphanumeric byte is escaped.
fn encode_key(key: &str) -> String {
    key.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn decode_key(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = encoded.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else if bytes[i].is_ascii_alphanumeric() {
            out.push(bytes[i]);
            i += 1;
        } else {
            return None;
        }
    }
    String::from_utf8(out).ok()
}

/// The URI a client opens. `launch` must come from [`normalize`].
pub fn uri(launch: &AppLaunch) -> String {
    match launch.launcher {
        Launcher::Rustdesk => {
            let mut uri = format!("{RUSTDESK_URI_PREFIX}{}", launch.peer_id);
            if let Some(server) = &launch.server {
                uri.push('@');
                uri.push_str(server);
            }
            if let Some(key) = &launch.key {
                uri.push_str("?key=");
                uri.push_str(&encode_key(key));
            }
            uri
        }
    }
}

/// Accept exactly what [`uri`] builds and nothing else: no other link form,
/// no other query parameter, no password.
pub fn parse_rustdesk_uri(uri: &str) -> Result<AppLaunch> {
    let invalid = || RemoteDesktopError::new("remote_desktop_launch_uri_invalid");
    if uri.len() > 512 {
        return Err(invalid());
    }
    let rest = uri.strip_prefix(RUSTDESK_URI_PREFIX).ok_or_else(invalid)?;
    let (path, query) = match rest.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (rest, None),
    };
    let (peer_id, server) = match path.split_once('@') {
        Some((peer_id, server)) => (peer_id, Some(server)),
        None => (path, None),
    };
    let key = match query {
        None => None,
        Some(query) => Some(decode_key(query.strip_prefix("key=").ok_or_else(invalid)?).ok_or_else(invalid)?),
    };
    let launch = AppLaunch {
        launcher: Launcher::Rustdesk,
        peer_id: peer_id.to_owned(),
        server: server.map(str::to_owned),
        key,
    };
    let normalized = normalize(&launch).map_err(|_| invalid())?;
    if normalized != launch || self::uri(&normalized) != uri {
        return Err(invalid());
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(peer_id: &str, server: Option<&str>, key: Option<&str>) -> AppLaunch {
        AppLaunch {
            launcher: Launcher::Rustdesk,
            peer_id: peer_id.into(),
            server: server.map(Into::into),
            key: key.map(Into::into),
        }
    }

    #[test]
    fn ids_lose_their_display_spaces_and_optionals_their_blanks() {
        let normalized = normalize(&launch(" 123 456 789 ", Some("  "), Some(""))).unwrap();
        assert_eq!(normalized, launch("123456789", None, None));
        assert_eq!(uri(&normalized), "rustdesk://connection/new/123456789");
        assert_eq!(normalize(&launch("Office_PC-2", None, None)).unwrap().peer_id, "Office_PC-2");
    }

    #[test]
    fn a_self_hosted_server_and_key_survive_dart_query_decoding() {
        let normalized = normalize(&launch("123456789", Some("rd.example.com:21116"), Some("OeVuKk5n+R/a=="))).unwrap();
        let built = uri(&normalized);
        assert_eq!(built, "rustdesk://connection/new/123456789@rd.example.com:21116?key=OeVuKk5n%2BR%2Fa%3D%3D");
        assert_eq!(parse_rustdesk_uri(&built).unwrap(), normalized);
        for server in ["10.0.0.4", "10.0.0.4:21116", "[fd00::1]", "[fd00::1]:21116"] {
            let launch = normalize(&launch("123456789", Some(server), None)).unwrap();
            assert_eq!(parse_rustdesk_uri(&uri(&launch)).unwrap(), launch, "{server}");
        }
    }

    #[test]
    fn bad_ids_servers_and_keys_are_refused_by_name() {
        for id in ["12345", "-123456", "123 456/7", "1234567@x", &"9".repeat(33), "abc?def1"] {
            assert_eq!(normalize(&launch(id, None, None)).unwrap_err().code, "remote_desktop_launch_peer_invalid", "{id}");
        }
        for server in ["bad host", "host:0", "host:70000", "fd00::1", "[fd00::1", "host/path", "a@b"] {
            assert_eq!(
                normalize(&launch("123456789", Some(server), None)).unwrap_err().code,
                "remote_desktop_launch_server_invalid",
                "{server}"
            );
        }
        for key in ["has space", "a&password=x", &"A".repeat(MAX_KEY_BYTES + 1)] {
            assert_eq!(
                normalize(&launch("123456789", None, Some(key))).unwrap_err().code,
                "remote_desktop_launch_key_invalid",
                "{key}"
            );
        }
    }

    #[test]
    fn only_the_connect_form_without_extras_parses() {
        for uri in [
            "rustdesk://123456789",
            "rustdesk://config/abc",
            "rustdesk://password/abc",
            "rustdesk://connection/new/123456789?password=x",
            "rustdesk://connection/new/123456789?key=a&password=x",
            "rustdesk://connection/new/123456789?relay",
            "rustdesk://connection/new/123456789/extra",
            "rustdesk://connection/new/123 456 789",
            "rustdesk://connection/new/123456789?key=a+b",
            "https://connection/new/123456789",
            "RUSTDESK://connection/new/123456789",
        ] {
            assert_eq!(parse_rustdesk_uri(uri).unwrap_err().code, "remote_desktop_launch_uri_invalid", "{uri}");
        }
        assert!(parse_rustdesk_uri("rustdesk://connection/new/123456789").is_ok());
    }
}
