//! The two facts `probe` needs from an ELF header: the machine it was built
//! for, and the dynamic loader it asks for (`PT_INTERP`).
//!
//! The loader is how an image's libc is identified. Checking which loader
//! FILES exist is not enough: Debian's `musl` package installs
//! `ld-musl-x86_64.so.1` beside glibc, and Alpine's `gcompat` installs an
//! `ld-linux-x86-64.so.2`. The interpreter the image's own `/bin/sh` was linked
//! against is what the userland actually runs on.

use std::io::Read;
use std::path::Path;

/// Enough of the header for any 64-bit program header table we care about.
const MAX_HEADER_READ: u64 = 64 * 1024;
const PT_INTERP: u32 = 3;
const MAX_INTERP_LEN: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElfInfo {
    /// `e_machine`.
    pub machine: u16,
    /// The `PT_INTERP` path, `None` for a static binary.
    pub interpreter: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ElfError {
    #[error("not an ELF file")]
    NotElf,
    #[error("only 64-bit ELF is supported")]
    Not64Bit,
    #[error("malformed ELF: {0}")]
    Malformed(&'static str),
}

/// Reads the header and program headers of the file at `path`.
pub fn inspect_file(path: &Path) -> std::io::Result<Result<ElfInfo, ElfError>> {
    let mut file = std::fs::File::open(path)?;
    let mut head = Vec::new();
    (&mut file).take(MAX_HEADER_READ).read_to_end(&mut head)?;
    let info = match parse_header(&head) {
        Ok(header) => header,
        Err(error) => return Ok(Err(error)),
    };
    let Some((offset, size)) = info.interp else {
        return Ok(Ok(ElfInfo {
            machine: info.machine,
            interpreter: None,
        }));
    };
    if size == 0 || size > MAX_INTERP_LEN {
        return Ok(Err(ElfError::Malformed("interpreter size")));
    }
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(offset))?;
    let mut raw = vec![0; size as usize];
    if file.read_exact(&mut raw).is_err() {
        return Ok(Err(ElfError::Malformed("interpreter out of range")));
    }
    Ok(interpreter_from(&raw).map(|interpreter| ElfInfo {
        machine: info.machine,
        interpreter: Some(interpreter),
    }))
}

/// Parses a complete ELF image held in memory.
pub fn inspect_bytes(bytes: &[u8]) -> Result<ElfInfo, ElfError> {
    let header = parse_header(bytes)?;
    let interpreter = match header.interp {
        None => None,
        Some((offset, size)) => {
            if size == 0 || size > MAX_INTERP_LEN {
                return Err(ElfError::Malformed("interpreter size"));
            }
            let start = usize::try_from(offset).map_err(|_| ElfError::Malformed("offset"))?;
            let end = start
                .checked_add(size as usize)
                .ok_or(ElfError::Malformed("offset"))?;
            let raw = bytes
                .get(start..end)
                .ok_or(ElfError::Malformed("interpreter out of range"))?;
            Some(interpreter_from(raw)?)
        }
    };
    Ok(ElfInfo {
        machine: header.machine,
        interpreter,
    })
}

struct Header {
    machine: u16,
    interp: Option<(u64, u64)>,
}

fn parse_header(bytes: &[u8]) -> Result<Header, ElfError> {
    if bytes.len() < 4 || &bytes[..4] != b"\x7fELF" {
        return Err(ElfError::NotElf);
    }
    if bytes.len() < 64 {
        return Err(ElfError::Malformed("truncated header"));
    }
    if bytes[4] != 2 {
        return Err(ElfError::Not64Bit);
    }
    let little = match bytes[5] {
        1 => true,
        2 => false,
        _ => return Err(ElfError::Malformed("data encoding")),
    };
    let u16_at = |at: usize| {
        let raw = [bytes[at], bytes[at + 1]];
        if little {
            u16::from_le_bytes(raw)
        } else {
            u16::from_be_bytes(raw)
        }
    };
    let u32_at = |at: usize| {
        let raw: [u8; 4] = bytes[at..at + 4].try_into().expect("4 bytes");
        if little {
            u32::from_le_bytes(raw)
        } else {
            u32::from_be_bytes(raw)
        }
    };
    let u64_at = |at: usize| {
        let raw: [u8; 8] = bytes[at..at + 8].try_into().expect("8 bytes");
        if little {
            u64::from_le_bytes(raw)
        } else {
            u64::from_be_bytes(raw)
        }
    };

    let machine = u16_at(18);
    let phoff = u64_at(32);
    let phentsize = u16_at(54) as u64;
    let phnum = u16_at(56) as u64;
    if phnum == 0 {
        return Ok(Header {
            machine,
            interp: None,
        });
    }
    if phentsize < 56 {
        return Err(ElfError::Malformed("program header size"));
    }
    let table_end = phoff
        .checked_add(phentsize * phnum)
        .ok_or(ElfError::Malformed("program header table"))?;
    if table_end > bytes.len() as u64 {
        return Err(ElfError::Malformed("program header table out of range"));
    }
    for index in 0..phnum {
        let at = (phoff + index * phentsize) as usize;
        if u32_at(at) == PT_INTERP {
            return Ok(Header {
                machine,
                interp: Some((u64_at(at + 8), u64_at(at + 32))),
            });
        }
    }
    Ok(Header {
        machine,
        interp: None,
    })
}

fn interpreter_from(raw: &[u8]) -> Result<String, ElfError> {
    let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
    let text = std::str::from_utf8(&raw[..end]).map_err(|_| ElfError::Malformed("interpreter"))?;
    if text.is_empty() {
        return Err(ElfError::Malformed("interpreter"));
    }
    Ok(text.to_string())
}

/// A minimal little-endian ELF64 image, for tests across the crate.
#[cfg(test)]
pub(crate) fn test_elf(machine: u16, interpreter: Option<&str>) -> Vec<u8> {
    let mut bytes = vec![0u8; 64];
    bytes[..4].copy_from_slice(b"\x7fELF");
    bytes[4] = 2; // ELFCLASS64
    bytes[5] = 1; // little endian
    bytes[6] = 1;
    bytes[16..18].copy_from_slice(&2u16.to_le_bytes()); // ET_EXEC
    bytes[18..20].copy_from_slice(&machine.to_le_bytes());
    let Some(interpreter) = interpreter else {
        return bytes;
    };
    let phoff = 64u64;
    bytes[32..40].copy_from_slice(&phoff.to_le_bytes());
    bytes[54..56].copy_from_slice(&56u16.to_le_bytes());
    // A PT_LOAD first, so the search has to skip an entry.
    bytes[56..58].copy_from_slice(&2u16.to_le_bytes());
    let mut load = vec![0u8; 56];
    load[..4].copy_from_slice(&1u32.to_le_bytes());
    let mut interp = vec![0u8; 56];
    let data_offset = 64 + 56 * 2;
    interp[..4].copy_from_slice(&PT_INTERP.to_le_bytes());
    interp[8..16].copy_from_slice(&(data_offset as u64).to_le_bytes());
    interp[32..40].copy_from_slice(&((interpreter.len() + 1) as u64).to_le_bytes());
    bytes.extend(load);
    bytes.extend(interp);
    bytes.extend(interpreter.as_bytes());
    bytes.push(0);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_machine_and_interpreter() {
        let bytes = test_elf(62, Some("/lib/ld-musl-x86_64.so.1"));
        assert_eq!(
            inspect_bytes(&bytes).unwrap(),
            ElfInfo {
                machine: 62,
                interpreter: Some("/lib/ld-musl-x86_64.so.1".into())
            }
        );

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sh");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            inspect_file(&path).unwrap().unwrap().interpreter.as_deref(),
            Some("/lib/ld-musl-x86_64.so.1")
        );
    }

    #[test]
    fn a_static_binary_has_no_interpreter() {
        assert_eq!(
            inspect_bytes(&test_elf(183, None)).unwrap(),
            ElfInfo {
                machine: 183,
                interpreter: None
            }
        );
    }

    #[test]
    fn refuses_what_is_not_a_64_bit_elf() {
        assert_eq!(inspect_bytes(b"#!/bin/sh\n"), Err(ElfError::NotElf));
        let mut elf32 = test_elf(62, None);
        elf32[4] = 1;
        assert_eq!(inspect_bytes(&elf32), Err(ElfError::Not64Bit));
        assert_eq!(
            inspect_bytes(&test_elf(62, None)[..40]),
            Err(ElfError::Malformed("truncated header"))
        );

        let mut out_of_range = test_elf(62, Some("/lib/ld.so"));
        let len = out_of_range.len();
        out_of_range.truncate(len - 4);
        assert_eq!(
            inspect_bytes(&out_of_range),
            Err(ElfError::Malformed("interpreter out of range"))
        );

        let mut table_past_end = test_elf(62, Some("/lib/ld.so"));
        table_past_end[56..58].copy_from_slice(&500u16.to_le_bytes());
        assert_eq!(
            inspect_bytes(&table_past_end),
            Err(ElfError::Malformed("program header table out of range"))
        );
    }
}
