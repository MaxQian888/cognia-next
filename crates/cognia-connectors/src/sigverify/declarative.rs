//! Webhook verification a plugin connector can DESCRIBE, executed by this
//! crate rather than by the plugin.
//!
//! ## Why a description and not a callback
//!
//! A plugin connector's code is TypeScript running in the renderer or the
//! brain, and the Python bridge only carries requests plugin-to-host, so there
//! is no host-to-plugin request primitive to call back through. Even if there
//! were, Slack, Discord and Lark all require the URL-verification handshake to
//! be answered within about three seconds, and an unconstrained consumer in
//! that path is not acceptable. The decisive reason is the third one: a
//! callback would hand an unauthenticated public POST body to plugin code
//! BEFORE anything proved where it came from, which is the exact job
//! verification exists to do.
//!
//! So a connector declares the shape of its platform's scheme and this module
//! runs it. Three forms cover what real IM platforms actually do.
//!
//! ## What `secret_key` means
//!
//! It names a keyring entry for the adapter, never an inline secret. A
//! manifest is world-readable inside the install directory, so a spec that
//! could carry a key would be a spec that leaks one.

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::SigError;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

/// Digest a platform signs with. SHA-1 is here because some platforms still
/// use it, not because it is a reasonable default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignatureDigest {
    Sha256,
    Sha1,
}

/// How the digest is rendered in the header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignatureEncoding {
    Hex,
    Base64,
}

fn default_digest() -> SignatureDigest {
    SignatureDigest::Sha256
}
fn default_encoding() -> SignatureEncoding {
    SignatureEncoding::Hex
}
/// Slack's window, and a sane ceiling for anything else.
fn default_tolerance_secs() -> i64 {
    300
}
/// Signing the body alone is the common case.
fn default_basestring() -> String {
    "{body}".to_string()
}

/// A connector's declared inbound verification scheme.
/// `rename_all` alone renames the VARIANTS, which is what the `kind` tag
/// carries. `rename_all_fields` is the half that renames each variant's
/// fields, and without it a manifest written in the documented camelCase shape
/// fails to deserialise with "missing field `secret_key`".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WebhookVerificationSpec {
    /// HMAC over a basestring built from the timestamp and the RAW body.
    ///
    /// Covers the Slack and WeChat families. The basestring is a template so a
    /// platform that signs `v0:<ts>:<body>` and one that signs the body alone
    /// are the same code path.
    HmacSha256 {
        /// Keyring entry holding the signing secret for this adapter.
        secret_key: String,
        /// Header carrying the signature, e.g. `X-Slack-Signature`.
        signature_header: String,
        /// Literal prefix on the header value, e.g. `v0=`. Compared as part of
        /// the value so a platform that omits it cannot pass by supplying one.
        #[serde(default)]
        signature_prefix: Option<String>,
        #[serde(default = "default_digest")]
        digest: SignatureDigest,
        #[serde(default = "default_encoding")]
        encoding: SignatureEncoding,
        /// `{timestamp}` and `{body}` are substituted. Anything else is literal.
        #[serde(default = "default_basestring")]
        basestring: String,
        /// Header carrying unix seconds. Required when `basestring` uses
        /// `{timestamp}`, and what replay protection reads.
        #[serde(default)]
        timestamp_header: Option<String>,
        #[serde(default = "default_tolerance_secs")]
        tolerance_secs: i64,
    },
    /// A fixed secret echoed back in a header, compared in constant time.
    ///
    /// This is Telegram's scheme. It proves possession of the secret and
    /// nothing about the body, so it is only as good as the transport, which
    /// is why the receiver refuses to serve it over plaintext.
    SharedSecretHeader {
        secret_key: String,
        /// e.g. `X-Telegram-Bot-Api-Secret-Token`.
        header: String,
    },
}

/// The parts of a request this module needs, so the caller owns header
/// extraction and this stays testable without an axum request.
pub struct DeclarativeRequest<'a> {
    pub body: &'a [u8],
    /// Resolves a header name to its value, case-insensitively.
    pub header: &'a dyn Fn(&str) -> Option<String>,
    /// The signing secret already read from the keyring for `secret_key`.
    pub secret: &'a str,
    pub now_unix_secs: i64,
}

impl WebhookVerificationSpec {
    /// The keyring entry this spec needs read before `verify` can run.
    pub fn secret_key(&self) -> &str {
        match self {
            Self::HmacSha256 { secret_key, .. } => secret_key,
            Self::SharedSecretHeader { secret_key, .. } => secret_key,
        }
    }

    /// Reject a spec that cannot verify anything, at REGISTRATION time.
    ///
    /// A malformed spec discovered on the first inbound POST is an endpoint
    /// that has been publicly reachable and unverified for however long it
    /// took someone to send one.
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::HmacSha256 {
                secret_key,
                signature_header,
                basestring,
                timestamp_header,
                tolerance_secs,
                ..
            } => {
                if secret_key.trim().is_empty() {
                    return Err("verification.secretKey must not be empty");
                }
                if signature_header.trim().is_empty() {
                    return Err("verification.signatureHeader must not be empty");
                }
                if !basestring.contains("{body}") {
                    // A signature that does not cover the body authenticates
                    // the sender of SOME request, not this one, so a replayed
                    // header would carry an attacker's payload.
                    return Err("verification.basestring must include {body}");
                }
                if basestring.contains("{timestamp}") && timestamp_header.is_none() {
                    return Err("verification.timestampHeader is required by this basestring");
                }
                if timestamp_header.is_some() && *tolerance_secs <= 0 {
                    return Err("verification.toleranceSecs must be positive");
                }
                Ok(())
            }
            Self::SharedSecretHeader { secret_key, header } => {
                if secret_key.trim().is_empty() {
                    return Err("verification.secretKey must not be empty");
                }
                if header.trim().is_empty() {
                    return Err("verification.header must not be empty");
                }
                Ok(())
            }
        }
    }

    /// Run the declared scheme against one request.
    pub fn verify(&self, req: &DeclarativeRequest<'_>) -> Result<(), SigError> {
        match self {
            Self::SharedSecretHeader { header, .. } => {
                let provided = (req.header)(header).ok_or(SigError::Missing)?;
                if provided.is_empty() {
                    return Err(SigError::Missing);
                }
                if bool::from(provided.as_bytes().ct_eq(req.secret.as_bytes())) {
                    Ok(())
                } else {
                    Err(SigError::Mismatch)
                }
            }
            Self::HmacSha256 {
                signature_header,
                signature_prefix,
                digest,
                encoding,
                basestring,
                timestamp_header,
                tolerance_secs,
                ..
            } => {
                let provided = (req.header)(signature_header).ok_or(SigError::Missing)?;
                if provided.is_empty() {
                    return Err(SigError::Missing);
                }

                let timestamp = match timestamp_header {
                    Some(name) => {
                        let raw = (req.header)(name).ok_or(SigError::Missing)?;
                        let ts: i64 = raw.parse().map_err(|_| SigError::Stale)?;
                        if (req.now_unix_secs - ts).abs() > *tolerance_secs {
                            return Err(SigError::Stale);
                        }
                        Some(raw)
                    }
                    None => None,
                };

                let mac = compute_mac(
                    *digest,
                    req.secret.as_bytes(),
                    basestring,
                    timestamp.as_deref(),
                    req.body,
                );
                let rendered = match encoding {
                    SignatureEncoding::Hex => hex::encode(&mac),
                    SignatureEncoding::Base64 => {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode(&mac)
                    }
                };
                let expected = match signature_prefix {
                    Some(prefix) => format!("{prefix}{rendered}"),
                    None => rendered,
                };

                // Constant time, and over the whole header value including any
                // prefix, so a request cannot pass by supplying a prefix the
                // platform does not send.
                if bool::from(expected.as_bytes().ct_eq(provided.as_bytes())) {
                    Ok(())
                } else {
                    Err(SigError::Mismatch)
                }
            }
        }
    }
}

/// Feed the basestring template into the MAC without ever materialising the
/// body as a `String`.
///
/// The body is raw bytes that a platform signed byte for byte. Rendering the
/// template with `format!` would force it through `String::from_utf8_lossy`,
/// which substitutes U+FFFD and makes verification fail for any request that
/// is not valid UTF-8, so the template is walked and the body fed directly.
fn compute_mac(
    digest: SignatureDigest,
    secret: &[u8],
    basestring: &str,
    timestamp: Option<&str>,
    body: &[u8],
) -> Vec<u8> {
    fn feed<M: Mac>(mac: &mut M, basestring: &str, timestamp: Option<&str>, body: &[u8]) {
        let mut rest = basestring;
        while !rest.is_empty() {
            let body_at = rest.find("{body}");
            let ts_at = rest.find("{timestamp}");
            let next = match (body_at, ts_at) {
                (None, None) => {
                    mac.update(rest.as_bytes());
                    return;
                }
                (Some(b), None) => (b, "{body}".len(), true),
                (None, Some(t)) => (t, "{timestamp}".len(), false),
                (Some(b), Some(t)) if b < t => (b, "{body}".len(), true),
                (Some(_), Some(t)) => (t, "{timestamp}".len(), false),
            };
            let (at, token_len, is_body) = next;
            mac.update(&rest.as_bytes()[..at]);
            if is_body {
                mac.update(body);
            } else {
                mac.update(timestamp.unwrap_or("").as_bytes());
            }
            rest = &rest[at + token_len..];
        }
    }

    match digest {
        SignatureDigest::Sha256 => {
            let mut mac =
                HmacSha256::new_from_slice(secret).expect("HMAC accepts a key of any size");
            feed(&mut mac, basestring, timestamp, body);
            mac.finalize().into_bytes().to_vec()
        }
        SignatureDigest::Sha1 => {
            let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC accepts a key of any size");
            feed(&mut mac, basestring, timestamp, body);
            mac.finalize().into_bytes().to_vec()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), (*v).to_string()))
            .collect()
    }

    fn request<'a>(
        body: &'a [u8],
        map: &'a HashMap<String, String>,
        secret: &'a str,
        now: i64,
        lookup: &'a dyn Fn(&str) -> Option<String>,
    ) -> DeclarativeRequest<'a> {
        let _ = map;
        DeclarativeRequest {
            body,
            header: lookup,
            secret,
            now_unix_secs: now,
        }
    }

    fn slack_like() -> WebhookVerificationSpec {
        WebhookVerificationSpec::HmacSha256 {
            secret_key: "signingSecret".into(),
            signature_header: "X-Sig".into(),
            signature_prefix: Some("v0=".into()),
            digest: SignatureDigest::Sha256,
            encoding: SignatureEncoding::Hex,
            basestring: "v0:{timestamp}:{body}".into(),
            timestamp_header: Some("X-Ts".into()),
            tolerance_secs: 300,
        }
    }

    fn sign(spec: &WebhookVerificationSpec, secret: &str, ts: &str, body: &[u8]) -> String {
        match spec {
            WebhookVerificationSpec::HmacSha256 {
                digest,
                encoding,
                basestring,
                signature_prefix,
                ..
            } => {
                let mac = compute_mac(*digest, secret.as_bytes(), basestring, Some(ts), body);
                let rendered = match encoding {
                    SignatureEncoding::Hex => hex::encode(&mac),
                    SignatureEncoding::Base64 => {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD.encode(&mac)
                    }
                };
                format!("{}{rendered}", signature_prefix.clone().unwrap_or_default())
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn hmac_accepts_a_correctly_signed_request() {
        let spec = slack_like();
        let body = br#"{"event":"ping"}"#;
        let sig = sign(&spec, "s3cret", "1700000000", body);
        let map = headers(&[("x-sig", &sig), ("x-ts", "1700000000")]);
        let lookup = |name: &str| map.get(&name.to_ascii_lowercase()).cloned();
        let req = request(body, &map, "s3cret", 1_700_000_000, &lookup);
        assert!(spec.verify(&req).is_ok());
    }

    #[test]
    fn hmac_rejects_a_body_that_changed_under_a_valid_signature() {
        let spec = slack_like();
        let sig = sign(&spec, "s3cret", "1700000000", b"original");
        let map = headers(&[("x-sig", &sig), ("x-ts", "1700000000")]);
        let lookup = |name: &str| map.get(&name.to_ascii_lowercase()).cloned();
        let req = request(b"tampered", &map, "s3cret", 1_700_000_000, &lookup);
        assert!(matches!(spec.verify(&req), Err(SigError::Mismatch)));
    }

    #[test]
    fn hmac_rejects_a_stale_timestamp_before_looking_at_the_signature() {
        let spec = slack_like();
        let sig = sign(&spec, "s3cret", "1700000000", b"body");
        let map = headers(&[("x-sig", &sig), ("x-ts", "1700000000")]);
        let lookup = |name: &str| map.get(&name.to_ascii_lowercase()).cloned();
        // Same request, replayed an hour later.
        let req = request(b"body", &map, "s3cret", 1_700_003_601, &lookup);
        assert!(matches!(spec.verify(&req), Err(SigError::Stale)));
    }

    #[test]
    fn hmac_rejects_a_missing_signature_header() {
        let spec = slack_like();
        let map = headers(&[("x-ts", "1700000000")]);
        let lookup = |name: &str| map.get(&name.to_ascii_lowercase()).cloned();
        let req = request(b"body", &map, "s3cret", 1_700_000_000, &lookup);
        assert!(matches!(spec.verify(&req), Err(SigError::Missing)));
    }

    #[test]
    fn hmac_signs_the_raw_bytes_of_a_non_utf8_body() {
        // Rendering the basestring through a String would substitute U+FFFD
        // and diverge from what the platform signed.
        let spec = slack_like();
        let body: &[u8] = &[0xff, 0xfe, 0x00, 0x41];
        let sig = sign(&spec, "s3cret", "1700000000", body);
        let map = headers(&[("x-sig", &sig), ("x-ts", "1700000000")]);
        let lookup = |name: &str| map.get(&name.to_ascii_lowercase()).cloned();
        let req = request(body, &map, "s3cret", 1_700_000_000, &lookup);
        assert!(spec.verify(&req).is_ok());
    }

    #[test]
    fn hmac_supports_base64_and_a_body_only_basestring() {
        let spec = WebhookVerificationSpec::HmacSha256 {
            secret_key: "k".into(),
            signature_header: "X-Sign".into(),
            signature_prefix: None,
            digest: SignatureDigest::Sha256,
            encoding: SignatureEncoding::Base64,
            basestring: "{body}".into(),
            timestamp_header: None,
            tolerance_secs: 300,
        };
        let mac = compute_mac(SignatureDigest::Sha256, b"k3y", "{body}", None, b"payload");
        use base64::Engine as _;
        let sig = base64::engine::general_purpose::STANDARD.encode(&mac);
        let map = headers(&[("x-sign", &sig)]);
        let lookup = |name: &str| map.get(&name.to_ascii_lowercase()).cloned();
        let req = request(b"payload", &map, "k3y", 0, &lookup);
        assert!(spec.verify(&req).is_ok());
    }

    #[test]
    fn hmac_rejects_a_signature_that_omits_the_declared_prefix() {
        // The prefix is part of the compared value, so stripping it must fail
        // rather than being tolerated as an equivalent encoding.
        let spec = slack_like();
        let full = sign(&spec, "s3cret", "1700000000", b"body");
        let without = full.trim_start_matches("v0=").to_string();
        let map = headers(&[("x-sig", &without), ("x-ts", "1700000000")]);
        let lookup = |name: &str| map.get(&name.to_ascii_lowercase()).cloned();
        let req = request(b"body", &map, "s3cret", 1_700_000_000, &lookup);
        assert!(matches!(spec.verify(&req), Err(SigError::Mismatch)));
    }

    #[test]
    fn shared_secret_matches_and_mismatches() {
        let spec = WebhookVerificationSpec::SharedSecretHeader {
            secret_key: "secretToken".into(),
            header: "X-Token".into(),
        };
        let ok = headers(&[("x-token", "tok")]);
        let ok_lookup = |name: &str| ok.get(&name.to_ascii_lowercase()).cloned();
        assert!(spec
            .verify(&request(b"", &ok, "tok", 0, &ok_lookup))
            .is_ok());

        let bad = headers(&[("x-token", "nope")]);
        let bad_lookup = |name: &str| bad.get(&name.to_ascii_lowercase()).cloned();
        assert!(matches!(
            spec.verify(&request(b"", &bad, "tok", 0, &bad_lookup)),
            Err(SigError::Mismatch)
        ));

        let none = headers(&[]);
        let none_lookup = |name: &str| none.get(&name.to_ascii_lowercase()).cloned();
        assert!(matches!(
            spec.verify(&request(b"", &none, "tok", 0, &none_lookup)),
            Err(SigError::Missing)
        ));
    }

    #[test]
    fn validate_refuses_a_basestring_that_does_not_cover_the_body() {
        // Such a signature authenticates the sender of some request, not this
        // one, so a captured header would carry an attacker's payload.
        let spec = WebhookVerificationSpec::HmacSha256 {
            secret_key: "k".into(),
            signature_header: "X-Sig".into(),
            signature_prefix: None,
            digest: SignatureDigest::Sha256,
            encoding: SignatureEncoding::Hex,
            basestring: "{timestamp}".into(),
            timestamp_header: Some("X-Ts".into()),
            tolerance_secs: 300,
        };
        assert_eq!(
            spec.validate(),
            Err("verification.basestring must include {body}")
        );
    }

    #[test]
    fn validate_refuses_a_timestamped_basestring_with_no_timestamp_header() {
        let spec = WebhookVerificationSpec::HmacSha256 {
            secret_key: "k".into(),
            signature_header: "X-Sig".into(),
            signature_prefix: None,
            digest: SignatureDigest::Sha256,
            encoding: SignatureEncoding::Hex,
            basestring: "{timestamp}:{body}".into(),
            timestamp_header: None,
            tolerance_secs: 300,
        };
        assert!(spec.validate().is_err());
    }

    #[test]
    fn validate_refuses_empty_names() {
        let spec = WebhookVerificationSpec::SharedSecretHeader {
            secret_key: "  ".into(),
            header: "X".into(),
        };
        assert!(spec.validate().is_err());
        let spec = WebhookVerificationSpec::SharedSecretHeader {
            secret_key: "k".into(),
            header: "".into(),
        };
        assert!(spec.validate().is_err());
    }

    #[test]
    fn validate_accepts_the_shapes_real_platforms_use() {
        assert!(slack_like().validate().is_ok());
        assert!(WebhookVerificationSpec::SharedSecretHeader {
            secret_key: "secretToken".into(),
            header: "X-Telegram-Bot-Api-Secret-Token".into(),
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn spec_round_trips_through_json_in_the_manifest_shape() {
        let json = serde_json::json!({
            "kind": "hmacSha256",
            "secretKey": "signingSecret",
            "signatureHeader": "X-Sig",
            "signaturePrefix": "v0=",
            "basestring": "v0:{timestamp}:{body}",
            "timestampHeader": "X-Ts"
        });
        let spec: WebhookVerificationSpec = serde_json::from_value(json).unwrap();
        // Defaults fill in for everything the author left out.
        match &spec {
            WebhookVerificationSpec::HmacSha256 {
                digest,
                encoding,
                tolerance_secs,
                ..
            } => {
                assert_eq!(*digest, SignatureDigest::Sha256);
                assert_eq!(*encoding, SignatureEncoding::Hex);
                assert_eq!(*tolerance_secs, 300);
            }
            _ => panic!("wrong variant"),
        }
        assert!(spec.validate().is_ok());
    }
}
