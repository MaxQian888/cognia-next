//! The slice of NSS (Firefox's crypto library) needed to read `key4.db`
//! without a primary password.
//!
//! `key4.db` holds a global salt and an encrypted `password-check` string in
//! `metaData` (`id = 'password'`), and the encrypted login key(s) in
//! `nssPrivate` (`a11` value, `a102` key id). Both are PKCS#5-encrypted with a
//! key derived from `SHA1(global_salt || primary_password)`:
//!
//! - PBES2: PBKDF2-HMAC-SHA256 (or SHA-1 when no PRF is named) → AES-256-CBC,
//!   IV = `04 0e` + the 14 stored bytes (NSS stores a truncated DER octet
//!   string).
//! - Legacy `pbeWithSha1AndTripleDES-CBC`: the NSS HMAC-SHA1 derivation →
//!   3DES-CBC.
//!
//! With an empty primary password the check decrypts to `password-check`;
//! otherwise a primary password is set and the import stops with
//! [`ImportError::PrimaryPasswordSet`].
//!
//! `logins.json` fields are base64 DER `SEQ { key id, SEQ { cipher OID, IV },
//! ciphertext }` encrypted with the login key: 3DES-CBC or AES-256-CBC.

use std::path::Path;

use aes::Aes256;
use cbc::cipher::{block_padding::NoPadding, BlockModeDecrypt, KeyIvInit};
use des::TdesEde3;
use hmac::{Hmac, KeyInit, Mac};
use pbkdf2::pbkdf2_hmac;
use sha1::{Digest, Sha1};
use sha2::Sha256;
use zeroize::Zeroize;

use crate::chromium::{open_immutable, snapshot_database};
use crate::secret::SecretBytes;
use crate::ImportError;

pub const OID_PBES2: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d];
pub const OID_PBKDF2: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0c];
pub const OID_HMAC_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x09];
pub const OID_HMAC_SHA1: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x07];
pub const OID_AES256_CBC: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a];
pub const OID_PBE_SHA1_3DES: &[u8] = &[
    0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x05, 0x01, 0x03,
];
pub const OID_DES_EDE3_CBC: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x03, 0x07];

const PASSWORD_CHECK: &[u8] = b"password-check";
const MAX_ITERATIONS: u32 = 10_000_000;

/// A minimal DER value tree: only what NSS structures use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Der {
    Sequence(Vec<Der>),
    Integer(Vec<u8>),
    OctetString(Vec<u8>),
    Oid(Vec<u8>),
    Null,
    Other(u8, Vec<u8>),
}

impl Der {
    fn items(&self) -> Option<&[Der]> {
        match self {
            Self::Sequence(items) => Some(items),
            _ => None,
        }
    }

    fn octets(&self) -> Option<&[u8]> {
        match self {
            Self::OctetString(bytes) => Some(bytes),
            _ => None,
        }
    }

    fn oid(&self) -> Option<&[u8]> {
        match self {
            Self::Oid(bytes) => Some(bytes),
            _ => None,
        }
    }

    fn uint(&self) -> Option<u32> {
        let Self::Integer(bytes) = self else {
            return None;
        };
        let trimmed = bytes
            .iter()
            .skip_while(|byte| **byte == 0)
            .copied()
            .collect::<Vec<_>>();
        if trimmed.len() > 4 {
            return None;
        }
        Some(
            trimmed
                .iter()
                .fold(0_u32, |acc, byte| (acc << 8) | u32::from(*byte)),
        )
    }
}

fn parse_length(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
    let first = *bytes.get(at)?;
    if first < 0x80 {
        return Some((first as usize, 1));
    }
    let count = (first & 0x7f) as usize;
    if count == 0 || count > 4 {
        return None;
    }
    let mut length = 0_usize;
    for index in 0..count {
        length = (length << 8) | *bytes.get(at + 1 + index)? as usize;
    }
    Some((length, 1 + count))
}

/// Parse one DER value; returns it and the bytes consumed.
pub fn parse_der(bytes: &[u8]) -> Result<(Der, usize), ImportError> {
    parse_at(bytes, 0, 0).ok_or(ImportError::InvalidFormat)
}

fn parse_at(bytes: &[u8], at: usize, depth: usize) -> Option<(Der, usize)> {
    if depth > 16 {
        return None;
    }
    let tag = *bytes.get(at)?;
    let (length, length_bytes) = parse_length(bytes, at + 1)?;
    let start = at + 1 + length_bytes;
    let end = start.checked_add(length)?;
    let body = bytes.get(start..end)?;
    let value = match tag {
        0x30 => {
            let mut items = Vec::new();
            let mut cursor = 0;
            while cursor < body.len() {
                let (item, used) = parse_at(body, cursor, depth + 1)?;
                items.push(item);
                cursor += used;
            }
            Der::Sequence(items)
        }
        0x02 => Der::Integer(body.to_vec()),
        0x04 => Der::OctetString(body.to_vec()),
        0x06 => Der::Oid(body.to_vec()),
        0x05 => Der::Null,
        other => Der::Other(other, body.to_vec()),
    };
    Some((value, end - at))
}

fn strip_pkcs7(mut plaintext: Vec<u8>, block: usize) -> Option<Vec<u8>> {
    let pad = *plaintext.last()? as usize;
    if pad == 0 || pad > block || pad > plaintext.len() {
        return None;
    }
    if !plaintext[plaintext.len() - pad..]
        .iter()
        .all(|byte| *byte as usize == pad)
    {
        return None;
    }
    plaintext.truncate(plaintext.len() - pad);
    Some(plaintext)
}

fn aes256_cbc(key: &[u8], iv: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
    let key: [u8; 32] = key.get(..32)?.try_into().ok()?;
    let iv: [u8; 16] = iv.try_into().ok()?;
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return None;
    }
    cbc::Decryptor::<Aes256>::new(&key.into(), &iv.into())
        .decrypt_padded_vec::<NoPadding>(ciphertext)
        .ok()
}

fn tdes_cbc(key: &[u8], iv: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
    let key: [u8; 24] = key.get(..24)?.try_into().ok()?;
    let iv: [u8; 8] = iv.try_into().ok()?;
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(8) {
        return None;
    }
    cbc::Decryptor::<TdesEde3>::new(&key.into(), &iv.into())
        .decrypt_padded_vec::<NoPadding>(ciphertext)
        .ok()
}

fn hmac_sha1(key: &[u8], data: &[u8]) -> [u8; 20] {
    let mut mac =
        <Hmac<Sha1> as KeyInit>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// NSS's legacy PKCS#12-style 3DES key and IV derivation.
pub fn legacy_3des_key_iv(
    global_salt: &[u8],
    password: &[u8],
    entry_salt: &[u8],
) -> ([u8; 24], [u8; 8]) {
    let hp = Sha1::digest([global_salt, password].concat());
    let mut pes = entry_salt.to_vec();
    pes.resize(pes.len().max(20), 0);
    let chp = Sha1::digest([hp.as_slice(), entry_salt].concat());
    let k1 = hmac_sha1(&chp, &[pes.as_slice(), entry_salt].concat());
    let tk = hmac_sha1(&chp, &pes);
    let k2 = hmac_sha1(&chp, &[tk.as_slice(), entry_salt].concat());
    let mut k = [k1.as_slice(), k2.as_slice()].concat();
    let key: [u8; 24] = k[..24].try_into().expect("40-byte derivation");
    let iv: [u8; 8] = k[32..40].try_into().expect("40-byte derivation");
    k.zeroize();
    (key, iv)
}

/// Decrypt one PKCS#5-encrypted NSS item (`SEQ { SEQ { alg OID, params },
/// ciphertext }`). Returns the unpadded plaintext.
pub fn decrypt_pbe(
    item: &Der,
    global_salt: &[u8],
    password: &[u8],
) -> Result<SecretBytes, ImportError> {
    let parts = item.items().ok_or(ImportError::InvalidFormat)?;
    let algorithm = parts
        .first()
        .and_then(Der::items)
        .ok_or(ImportError::InvalidFormat)?;
    let ciphertext = parts
        .get(1)
        .and_then(Der::octets)
        .ok_or(ImportError::InvalidFormat)?;
    let oid = algorithm
        .first()
        .and_then(Der::oid)
        .ok_or(ImportError::InvalidFormat)?;
    let params = algorithm
        .get(1)
        .and_then(Der::items)
        .ok_or(ImportError::InvalidFormat)?;

    let plaintext = if oid == OID_PBES2 {
        let kdf = params
            .first()
            .and_then(Der::items)
            .ok_or(ImportError::InvalidFormat)?;
        if kdf.first().and_then(Der::oid) != Some(OID_PBKDF2) {
            return Err(ImportError::InvalidFormat);
        }
        let kdf_params = kdf
            .get(1)
            .and_then(Der::items)
            .ok_or(ImportError::InvalidFormat)?;
        let salt = kdf_params
            .first()
            .and_then(Der::octets)
            .ok_or(ImportError::InvalidFormat)?;
        let iterations = kdf_params
            .get(1)
            .and_then(Der::uint)
            .ok_or(ImportError::InvalidFormat)?;
        if iterations == 0 || iterations > MAX_ITERATIONS {
            return Err(ImportError::InvalidFormat);
        }
        let mut key_length = 32_usize;
        let mut prf = OID_HMAC_SHA1;
        for extra in kdf_params.iter().skip(2) {
            match extra {
                Der::Integer(_) => {
                    key_length = extra.uint().ok_or(ImportError::InvalidFormat)? as usize
                }
                Der::Sequence(items) => {
                    prf = items
                        .first()
                        .and_then(Der::oid)
                        .ok_or(ImportError::InvalidFormat)?;
                }
                _ => {}
            }
        }
        if key_length != 32 {
            return Err(ImportError::InvalidFormat);
        }
        let cipher = params
            .get(1)
            .and_then(Der::items)
            .ok_or(ImportError::InvalidFormat)?;
        if cipher.first().and_then(Der::oid) != Some(OID_AES256_CBC) {
            return Err(ImportError::InvalidFormat);
        }
        let stored_iv = cipher
            .get(1)
            .and_then(Der::octets)
            .ok_or(ImportError::InvalidFormat)?;
        let iv = match stored_iv.len() {
            14 => [&[0x04, 0x0e], stored_iv].concat(),
            16 => stored_iv.to_vec(),
            _ => return Err(ImportError::InvalidFormat),
        };
        let mut k = Sha1::digest([global_salt, password].concat()).to_vec();
        let mut key = [0_u8; 32];
        if prf == OID_HMAC_SHA256 {
            pbkdf2_hmac::<Sha256>(&k, salt, iterations, &mut key);
        } else if prf == OID_HMAC_SHA1 {
            pbkdf2_hmac::<Sha1>(&k, salt, iterations, &mut key);
        } else {
            return Err(ImportError::InvalidFormat);
        }
        k.zeroize();
        let plaintext = aes256_cbc(&key, &iv, ciphertext);
        key.zeroize();
        plaintext.and_then(|plaintext| strip_pkcs7(plaintext, 16))
    } else if oid == OID_PBE_SHA1_3DES {
        let entry_salt = params
            .first()
            .and_then(Der::octets)
            .ok_or(ImportError::InvalidFormat)?;
        let (mut key, iv) = legacy_3des_key_iv(global_salt, password, entry_salt);
        let plaintext = tdes_cbc(&key, &iv, ciphertext);
        key.zeroize();
        plaintext.and_then(|plaintext| strip_pkcs7(plaintext, 8))
    } else {
        return Err(ImportError::InvalidFormat);
    };
    plaintext
        .map(SecretBytes::new)
        .ok_or(ImportError::Decryption)
}

/// The login keys of a `key4.db`, by `CKA_ID`.
pub struct NssKeys {
    keys: Vec<(Vec<u8>, SecretBytes)>,
}

impl std::fmt::Debug for NssKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NssKeys({} keys)", self.keys.len())
    }
}

impl NssKeys {
    fn key_for(&self, key_id: &[u8]) -> Option<&SecretBytes> {
        self.keys
            .iter()
            .find(|(id, _)| id == key_id)
            .or_else(|| self.keys.first())
            .map(|(_, key)| key)
    }

    /// Decrypt a base64 `logins.json` field.
    pub fn decrypt_field(&self, encoded: &str) -> Result<String, ImportError> {
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| ImportError::InvalidFormat)?;
        let (der, _) = parse_der(&raw)?;
        let parts = der.items().ok_or(ImportError::InvalidFormat)?;
        let key_id = parts
            .first()
            .and_then(Der::octets)
            .ok_or(ImportError::InvalidFormat)?;
        let cipher = parts
            .get(1)
            .and_then(Der::items)
            .ok_or(ImportError::InvalidFormat)?;
        let ciphertext = parts
            .get(2)
            .and_then(Der::octets)
            .ok_or(ImportError::InvalidFormat)?;
        let oid = cipher
            .first()
            .and_then(Der::oid)
            .ok_or(ImportError::InvalidFormat)?;
        let iv = cipher
            .get(1)
            .and_then(Der::octets)
            .ok_or(ImportError::InvalidFormat)?;
        let key = self.key_for(key_id).ok_or(ImportError::Decryption)?;
        let plaintext = if oid == OID_DES_EDE3_CBC {
            tdes_cbc(key.expose(), iv, ciphertext).and_then(|plaintext| strip_pkcs7(plaintext, 8))
        } else if oid == OID_AES256_CBC {
            aes256_cbc(key.expose(), iv, ciphertext)
                .and_then(|plaintext| strip_pkcs7(plaintext, 16))
        } else {
            return Err(ImportError::InvalidFormat);
        }
        .ok_or(ImportError::Decryption)?;
        String::from_utf8(plaintext).map_err(|error| {
            error.into_bytes().zeroize();
            ImportError::Decryption
        })
    }
}

/// Read the login keys of a `key4.db` with an empty primary password.
pub fn load_keys(key4: &Path) -> Result<NssKeys, ImportError> {
    let snapshot = snapshot_database(key4)?;
    let connection = open_immutable(&snapshot.path)?;
    let (global_salt, check): (Vec<u8>, Vec<u8>) = connection
        .query_row(
            "SELECT item1, item2 FROM metaData WHERE id = 'password'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| ImportError::InvalidFormat)?;
    let (check_item, _) = parse_der(&check)?;
    match decrypt_pbe(&check_item, &global_salt, b"") {
        Ok(plaintext) if plaintext.expose() == PASSWORD_CHECK => {}
        Ok(_) | Err(ImportError::Decryption) => return Err(ImportError::PrimaryPasswordSet),
        Err(error) => return Err(error),
    }
    let mut statement = connection
        .prepare("SELECT a11, a102 FROM nssPrivate")
        .map_err(|_| ImportError::InvalidFormat)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|_| ImportError::InvalidFormat)?;
    let mut keys = Vec::new();
    for (encrypted, key_id) in rows.filter_map(Result::ok) {
        let Ok((item, _)) = parse_der(&encrypted) else {
            continue;
        };
        if let Ok(key) = decrypt_pbe(&item, &global_salt, b"") {
            if key.len() >= 24 {
                keys.push((key_id, key));
            }
        }
    }
    if keys.is_empty() {
        return Err(ImportError::Decryption);
    }
    Ok(NssKeys { keys })
}

#[cfg(test)]
pub(crate) mod test_support {
    use aes::Aes256;
    use cbc::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
    use des::TdesEde3;
    use pbkdf2::pbkdf2_hmac;
    use rusqlite::Connection;
    use sha1::{Digest, Sha1};
    use sha2::Sha256;

    use super::*;

    pub fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        match body.len() {
            len if len < 0x80 => out.push(len as u8),
            len if len < 0x100 => out.extend_from_slice(&[0x81, len as u8]),
            len => out.extend_from_slice(&[0x82, (len >> 8) as u8, len as u8]),
        }
        out.extend_from_slice(body);
        out
    }

    pub fn seq(items: &[Vec<u8>]) -> Vec<u8> {
        tlv(0x30, &items.concat())
    }

    pub fn octets(bytes: &[u8]) -> Vec<u8> {
        tlv(0x04, bytes)
    }

    pub fn oid(bytes: &[u8]) -> Vec<u8> {
        tlv(0x06, bytes)
    }

    pub fn int(value: u32) -> Vec<u8> {
        let bytes = value.to_be_bytes();
        let start = bytes.iter().position(|byte| *byte != 0).unwrap_or(3);
        let mut body = bytes[start..].to_vec();
        if body[0] & 0x80 != 0 {
            body.insert(0, 0);
        }
        tlv(0x02, &body)
    }

    pub fn pbes2_encrypt(global_salt: &[u8], password: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let salt = [0x11_u8; 32];
        let iterations = 10;
        let iv14 = [0x22_u8; 14];
        let k = Sha1::digest([global_salt, password].concat());
        let mut key = [0_u8; 32];
        pbkdf2_hmac::<Sha256>(&k, &salt, iterations, &mut key);
        let iv: [u8; 16] = [&[0x04, 0x0e], iv14.as_slice()]
            .concat()
            .try_into()
            .unwrap();
        let ciphertext = cbc::Encryptor::<Aes256>::new(&key.into(), &iv.into())
            .encrypt_padded_vec::<Pkcs7>(plaintext);
        seq(&[
            seq(&[
                oid(OID_PBES2),
                seq(&[
                    seq(&[
                        oid(OID_PBKDF2),
                        seq(&[
                            octets(&salt),
                            int(iterations),
                            int(32),
                            seq(&[oid(OID_HMAC_SHA256)]),
                        ]),
                    ]),
                    seq(&[oid(OID_AES256_CBC), octets(&iv14)]),
                ]),
            ]),
            octets(&ciphertext),
        ])
    }

    pub fn legacy_encrypt(global_salt: &[u8], password: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let entry_salt = [0x33_u8; 20];
        let (key, iv) = legacy_3des_key_iv(global_salt, password, &entry_salt);
        let ciphertext = cbc::Encryptor::<TdesEde3>::new(&key.into(), &iv.into())
            .encrypt_padded_vec::<Pkcs7>(plaintext);
        seq(&[
            seq(&[oid(OID_PBE_SHA1_3DES), seq(&[octets(&entry_salt), int(1)])]),
            octets(&ciphertext),
        ])
    }

    pub const KEY_ID: &[u8] = &[0xf8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

    /// A key4.db whose login key is `login_key`, protected with `password`.
    pub fn write_key4(path: &std::path::Path, password: &[u8], login_key: &[u8], legacy: bool) {
        let global_salt = [0x44_u8; 20];
        let encrypt = if legacy {
            legacy_encrypt
        } else {
            pbes2_encrypt
        };
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE metaData(id PRIMARY KEY UNIQUE ON CONFLICT REPLACE, item1, item2);\
             CREATE TABLE nssPrivate(id PRIMARY KEY UNIQUE ON CONFLICT ABORT, a11, a102);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO metaData(id,item1,item2) VALUES('password',?1,?2)",
            rusqlite::params![
                global_salt.to_vec(),
                encrypt(&global_salt, password, PASSWORD_CHECK)
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nssPrivate(id,a11,a102) VALUES(1,?1,?2)",
            rusqlite::params![encrypt(&global_salt, password, login_key), KEY_ID.to_vec()],
        )
        .unwrap();
    }

    /// A base64 `logins.json` field encrypted with `login_key`.
    pub fn encrypt_field(login_key: &[u8], value: &str, aes: bool) -> String {
        use base64::Engine;
        let der = if aes {
            let iv = [0x55_u8; 16];
            let key: [u8; 32] = login_key[..32].try_into().unwrap();
            let ct = cbc::Encryptor::<Aes256>::new(&key.into(), &iv.into())
                .encrypt_padded_vec::<Pkcs7>(value.as_bytes());
            seq(&[
                octets(KEY_ID),
                seq(&[oid(OID_AES256_CBC), octets(&iv)]),
                octets(&ct),
            ])
        } else {
            let iv = [0x66_u8; 8];
            let key: [u8; 24] = login_key[..24].try_into().unwrap();
            let ct = cbc::Encryptor::<TdesEde3>::new(&key.into(), &iv.into())
                .encrypt_padded_vec::<Pkcs7>(value.as_bytes());
            seq(&[
                octets(KEY_ID),
                seq(&[oid(OID_DES_EDE3_CBC), octets(&iv)]),
                octets(&ct),
            ])
        };
        base64::engine::general_purpose::STANDARD.encode(der)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn parses_nested_der_with_long_lengths() {
        let long = vec![0xab_u8; 300];
        let encoded = seq(&[
            int(1000),
            octets(&long),
            oid(OID_PBES2),
            tlv(0x05, &[]),
            tlv(0x13, b"x"),
        ]);
        let (value, used) = parse_der(&encoded).unwrap();
        assert_eq!(used, encoded.len());
        let items = value.items().unwrap();
        assert_eq!(items[0].uint(), Some(1000));
        assert_eq!(items[1].octets().unwrap().len(), 300);
        assert_eq!(items[2].oid(), Some(OID_PBES2));
        assert_eq!(items[3], Der::Null);
        assert_eq!(items[4], Der::Other(0x13, b"x".to_vec()));
        assert!(parse_der(&[0x30, 0x05, 0x02]).is_err());
        assert!(parse_der(&[0x30, 0x85, 0, 0, 0, 0, 0]).is_err());
        assert_eq!(Der::Integer(vec![1, 2, 3, 4, 5]).uint(), None);
    }

    #[test]
    fn pkcs7_stripping_validates_padding() {
        assert_eq!(strip_pkcs7(vec![1, 2, 2], 8), Some(vec![1]));
        assert_eq!(strip_pkcs7(vec![1, 3, 2], 8), None);
        assert_eq!(strip_pkcs7(vec![1, 0], 8), None);
        assert_eq!(strip_pkcs7(vec![9; 9], 8), None);
        assert_eq!(strip_pkcs7(Vec::new(), 8), None);
    }

    #[test]
    fn decrypts_pbes2_and_legacy_items() {
        let salt = b"global-salt";
        let pbes2 = parse_der(&pbes2_encrypt(salt, b"", b"secret-key-bytes"))
            .unwrap()
            .0;
        assert_eq!(
            decrypt_pbe(&pbes2, salt, b"").unwrap().expose(),
            b"secret-key-bytes"
        );
        assert_eq!(
            decrypt_pbe(&pbes2, salt, b"wrong"),
            Err(ImportError::Decryption)
        );
        let legacy = parse_der(&legacy_encrypt(salt, b"", b"password-check"))
            .unwrap()
            .0;
        assert_eq!(
            decrypt_pbe(&legacy, salt, b"").unwrap().expose(),
            b"password-check"
        );
        let unknown = parse_der(&seq(&[seq(&[oid(&[1, 2, 3]), seq(&[])]), octets(&[0; 16])]))
            .unwrap()
            .0;
        assert_eq!(
            decrypt_pbe(&unknown, salt, b""),
            Err(ImportError::InvalidFormat)
        );
        assert_eq!(
            decrypt_pbe(&Der::Null, salt, b""),
            Err(ImportError::InvalidFormat)
        );
    }

    #[test]
    fn loads_keys_and_decrypts_3des_and_aes_fields() {
        for legacy in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let key4 = dir.path().join("key4.db");
            let login_key = [0x77_u8; 32];
            write_key4(&key4, b"", &login_key, legacy);
            let keys = load_keys(&key4).unwrap();
            assert_eq!(format!("{keys:?}"), "NssKeys(1 keys)");
            assert_eq!(
                keys.decrypt_field(&encrypt_field(&login_key, "alice", false))
                    .unwrap(),
                "alice"
            );
            assert_eq!(
                keys.decrypt_field(&encrypt_field(&login_key, "s3cret!", true))
                    .unwrap(),
                "s3cret!"
            );
            assert_eq!(
                keys.decrypt_field("not base64 !!"),
                Err(ImportError::InvalidFormat)
            );
            let wrong = encrypt_field(&[0x01; 32], "x", true);
            assert!(keys.decrypt_field(&wrong).is_err());
        }
    }

    #[test]
    fn a_primary_password_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let key4 = dir.path().join("key4.db");
        write_key4(&key4, b"primary", &[0x77; 32], false);
        assert_eq!(
            load_keys(&key4).map(|_| ()),
            Err(ImportError::PrimaryPasswordSet)
        );
        let legacy = dir.path().join("legacy.db");
        write_key4(&legacy, b"primary", &[0x77; 32], true);
        assert_eq!(
            load_keys(&legacy).map(|_| ()),
            Err(ImportError::PrimaryPasswordSet)
        );
    }

    #[test]
    fn a_database_without_metadata_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let key4 = dir.path().join("key4.db");
        rusqlite::Connection::open(&key4)
            .unwrap()
            .execute_batch("CREATE TABLE x(y);")
            .unwrap();
        assert_eq!(
            load_keys(&key4).map(|_| ()),
            Err(ImportError::InvalidFormat)
        );
    }
}
