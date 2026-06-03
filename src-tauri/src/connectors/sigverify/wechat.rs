//! WeChat Official Account (公众号) signature verification + message decryption.
//!
//! WeChat OA secures its callback in "safe mode" with:
//!   - A SHA-1 signature over the sorted `[token, timestamp, nonce]` (URL
//!     verification GET) or `[token, timestamp, nonce, encrypt]` (message POST).
//!   - AES-256-CBC encryption of the message body. The AES key is
//!     `base64decode(EncodingAESKey + "=")` (32 bytes); the IV is the first 16
//!     bytes of that key. The decrypted blob is laid out as
//!     `random(16) ++ msg_len(4, big-endian) ++ msg ++ appid`, padded with a
//!     PKCS#7-style scheme over a 32-byte block (pad value may exceed the AES
//!     block size, so we strip padding manually after a NoPadding decrypt).

use aes::cipher::{block_padding::NoPadding, BlockModeDecrypt, KeyIvInit};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha1::{Digest, Sha1};

use super::SigError;

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// SHA-1 hex digest of the sorted-and-joined parts (WeChat's signature scheme).
fn sha1_of_sorted(parts: &mut [&str]) -> String {
    parts.sort_unstable();
    let joined = parts.concat();
    let mut hasher = Sha1::new();
    hasher.update(joined.as_bytes());
    hex::encode(hasher.finalize())
}

/// Verify the URL-verification signature (GET): `signature == sha1(sort(token,
/// timestamp, nonce))`.
pub fn verify_signature(
    token: &str,
    timestamp: &str,
    nonce: &str,
    signature: &str,
) -> Result<(), SigError> {
    if signature.is_empty() {
        return Err(SigError::Missing);
    }
    let mut parts = [token, timestamp, nonce];
    let computed = sha1_of_sorted(&mut parts);
    if computed.eq_ignore_ascii_case(signature) {
        Ok(())
    } else {
        Err(SigError::Mismatch)
    }
}

/// Verify the message signature (POST safe mode): `msg_signature ==
/// sha1(sort(token, timestamp, nonce, encrypt))`.
pub fn verify_msg_signature(
    token: &str,
    timestamp: &str,
    nonce: &str,
    encrypt: &str,
    msg_signature: &str,
) -> Result<(), SigError> {
    if msg_signature.is_empty() {
        return Err(SigError::Missing);
    }
    let mut parts = [token, timestamp, nonce, encrypt];
    let computed = sha1_of_sorted(&mut parts);
    if computed.eq_ignore_ascii_case(msg_signature) {
        Ok(())
    } else {
        Err(SigError::Mismatch)
    }
}

/// Decrypt a WeChat OA `Encrypt` payload. Returns `(message_xml, app_id)`.
pub fn decrypt(encoding_aes_key: &str, encrypt_b64: &str) -> Result<(String, String), SigError> {
    // AES key = base64decode(EncodingAESKey + "=") — must be exactly 32 bytes.
    let key = BASE64
        .decode(format!("{encoding_aes_key}="))
        .map_err(|_| SigError::Mismatch)?;
    if key.len() != 32 {
        return Err(SigError::Mismatch);
    }
    let key_arr: [u8; 32] = key.as_slice().try_into().map_err(|_| SigError::Mismatch)?;
    let iv_arr: [u8; 16] = key[..16].try_into().map_err(|_| SigError::Mismatch)?;

    let cipher = BASE64.decode(encrypt_b64).map_err(|_| SigError::Mismatch)?;
    if cipher.is_empty() || cipher.len() % 16 != 0 {
        return Err(SigError::Mismatch);
    }

    // NoPadding decrypt, then strip WeChat's (block-32) PKCS#7 manually — the
    // pad value can exceed the AES block size, which the standard Pkcs7
    // unpadder rejects.
    let mut plain = Aes256CbcDec::new(&key_arr.into(), &iv_arr.into())
        .decrypt_padded_vec::<NoPadding>(&cipher)
        .map_err(|_| SigError::Mismatch)?;
    let pad = *plain.last().ok_or(SigError::Mismatch)? as usize;
    if pad == 0 || pad > 32 || pad > plain.len() {
        return Err(SigError::Mismatch);
    }
    plain.truncate(plain.len() - pad);

    // Layout: random(16) ++ msg_len(4, big-endian) ++ msg ++ appid.
    if plain.len() < 20 {
        return Err(SigError::Mismatch);
    }
    let msg_len = u32::from_be_bytes([plain[16], plain[17], plain[18], plain[19]]) as usize;
    if 20 + msg_len > plain.len() {
        return Err(SigError::Mismatch);
    }
    let msg = String::from_utf8(plain[20..20 + msg_len].to_vec()).map_err(|_| SigError::Mismatch)?;
    let appid = String::from_utf8(plain[20 + msg_len..].to_vec()).map_err(|_| SigError::Mismatch)?;
    Ok((msg, appid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{block_padding::NoPadding as NoPad, BlockModeEncrypt};

    type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

    /// 43-char EncodingAESKey whose `+"="` decodes to 32 zero bytes.
    fn test_aes_key() -> String {
        "A".repeat(43)
    }

    fn wechat_encrypt(encoding_aes_key: &str, msg: &str, appid: &str) -> String {
        let key = BASE64.decode(format!("{encoding_aes_key}=")).unwrap();
        let key_arr: [u8; 32] = key.as_slice().try_into().unwrap();
        let iv_arr: [u8; 16] = key[..16].try_into().unwrap();

        let mut buf = Vec::new();
        buf.extend_from_slice(&[0u8; 16]); // random prefix
        buf.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        buf.extend_from_slice(msg.as_bytes());
        buf.extend_from_slice(appid.as_bytes());
        // block-32 PKCS#7
        let block = 32usize;
        let mut pad = block - (buf.len() % block);
        if pad == 0 {
            pad = block;
        }
        for _ in 0..pad {
            buf.push(pad as u8);
        }

        let ct = Aes256CbcEnc::new(&key_arr.into(), &iv_arr.into())
            .encrypt_padded_vec::<NoPad>(&buf);
        BASE64.encode(ct)
    }

    #[test]
    fn signature_round_trip() {
        let token = "mytoken";
        let ts = "1700000000";
        let nonce = "abc123";
        let mut parts = [token, ts, nonce];
        let sig = sha1_of_sorted(&mut parts);
        assert!(verify_signature(token, ts, nonce, &sig).is_ok());
        // Case-insensitive match.
        assert!(verify_signature(token, ts, nonce, &sig.to_uppercase()).is_ok());
    }

    #[test]
    fn signature_mismatch_and_missing() {
        assert!(matches!(
            verify_signature("t", "1", "n", "deadbeef").unwrap_err(),
            SigError::Mismatch
        ));
        assert!(matches!(
            verify_signature("t", "1", "n", "").unwrap_err(),
            SigError::Missing
        ));
    }

    #[test]
    fn msg_signature_round_trip() {
        let token = "tk";
        let ts = "1700000001";
        let nonce = "n0nce";
        let encrypt = "ZW5jcnlwdGVkLXBheWxvYWQ=";
        let mut parts = [token, ts, nonce, encrypt];
        let sig = sha1_of_sorted(&mut parts);
        assert!(verify_msg_signature(token, ts, nonce, encrypt, &sig).is_ok());
        assert!(matches!(
            verify_msg_signature(token, ts, nonce, encrypt, "nope").unwrap_err(),
            SigError::Mismatch
        ));
    }

    #[test]
    fn decrypt_round_trip() {
        let key = test_aes_key();
        let msg = "<xml><Content><![CDATA[hi there]]></Content></xml>";
        let appid = "wxappid123";
        let enc = wechat_encrypt(&key, msg, appid);
        let (got_msg, got_appid) = decrypt(&key, &enc).expect("decrypt ok");
        assert_eq!(got_msg, msg);
        assert_eq!(got_appid, appid);
    }

    #[test]
    fn decrypt_rejects_bad_base64() {
        assert!(matches!(
            decrypt(&test_aes_key(), "!!!not base64!!!").unwrap_err(),
            SigError::Mismatch
        ));
    }

    #[test]
    fn decrypt_rejects_bad_key_length() {
        // "AAAA" + "=" decodes to 3 bytes, not 32.
        assert!(matches!(decrypt("AAAA", "QUFB").unwrap_err(), SigError::Mismatch));
    }
}
