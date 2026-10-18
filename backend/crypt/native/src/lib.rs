//! The blocks of the data of rclone crypt: NaCl secretbox, that is
//! XSalsa20 and Poly1305, for `../secretbox.js`.
//!
//! XSalsa20 is in `salsa.rs`: it computes 4 blocks of Salsa20 at a time
//! with the SIMD of WebAssembly, because the crate `salsa20` has no SIMD
//! for WebAssembly. Poly1305 is the crate `poly1305`. The tests compare each
//! box with the crate `crypto_secretbox`.
//!
//! The module has no imports. JavaScript writes the key, the nonce and the
//! input into the memory of the module, at the addresses that `key`,
//! `nonce` and `input` give. Then `seal` or `open` writes the output at the
//! address that `output` gives. The nonce goes up by 1 for each block, as a
//! number in little-endian bytes, thus JavaScript reads it back for the
//! next call.
#![cfg_attr(not(test), no_std)]

mod salsa;

use poly1305::universal_hash::KeyInit;
use poly1305::{Key, Poly1305};
use subtle::ConstantTimeEq;

/// The size of a Poly1305 tag.
const TAG: usize = 16;
/// The size of the input and of the output: 16 boxes of 64 KiB of data.
const SIZE: usize = 16 * (64 * 1024 + TAG);

static mut KEY: [u8; 32] = [0; 32];
static mut NONCE: [u8; 24] = [0; 24];
static mut INPUT: [u8; SIZE] = [0; SIZE];
static mut OUTPUT: [u8; SIZE] = [0; SIZE];

#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// The address of the key: 32 bytes.
#[no_mangle]
pub extern "C" fn key() -> *mut u8 {
    core::ptr::addr_of_mut!(KEY).cast()
}

/// The address of the nonce: 24 bytes.
#[no_mangle]
pub extern "C" fn nonce() -> *mut u8 {
    core::ptr::addr_of_mut!(NONCE).cast()
}

/// The address of the input: `size()` bytes.
#[no_mangle]
pub extern "C" fn input() -> *mut u8 {
    core::ptr::addr_of_mut!(INPUT).cast()
}

/// The address of the output: `size()` bytes.
#[no_mangle]
pub extern "C" fn output() -> *mut u8 {
    core::ptr::addr_of_mut!(OUTPUT).cast()
}

/// The size of the input and of the output.
#[no_mangle]
pub extern "C" fn size() -> usize {
    SIZE
}

/// Adds 1 to the nonce: the first byte is the lowest.
fn increment(nonce: &mut [u8; 24]) {
    for byte in nonce.iter_mut() {
        *byte = byte.wrapping_add(1);
        if *byte != 0 {
            break;
        }
    }
}

/// Seals the first `len` bytes of the input, in parts of `block` bytes: a
/// box for each part, with a tag and then the encrypted part. Gives the size
/// of the output, or 0 when the boxes are larger than the output.
#[no_mangle]
pub extern "C" fn seal(len: usize, block: usize) -> usize {
    if block == 0 || len > SIZE || len + TAG * len.div_ceil(block) > SIZE {
        return 0;
    }
    // SAFETY: JavaScript calls the functions of the module one at a time,
    // thus no other reference to the statics exists.
    let (key, nonce, input, output) = unsafe {
        (
            &*core::ptr::addr_of!(KEY),
            &mut *core::ptr::addr_of_mut!(NONCE),
            &*core::ptr::addr_of!(INPUT),
            &mut *core::ptr::addr_of_mut!(OUTPUT),
        )
    };
    let mut at = 0;
    for part in input[..len].chunks(block) {
        let (tag, data) = output[at..at + TAG + part.len()].split_at_mut(TAG);
        data.copy_from_slice(part);
        tag.copy_from_slice(&seal_box(key, nonce, data));
        at += TAG + part.len();
        increment(nonce);
    }
    at
}

/// Opens the first `len` bytes of the input: boxes of a tag and `block`
/// bytes of data, and a last box that can be shorter. Gives the size of the
/// data in the output, or -1 for a box of `TAG` bytes or less, or for a box
/// that does not authenticate.
#[no_mangle]
pub extern "C" fn open(len: usize, block: usize) -> isize {
    if block == 0 || len > SIZE {
        return -1;
    }
    // SAFETY: as for `seal`.
    let (key, nonce, input, output) = unsafe {
        (
            &*core::ptr::addr_of!(KEY),
            &mut *core::ptr::addr_of_mut!(NONCE),
            &*core::ptr::addr_of!(INPUT),
            &mut *core::ptr::addr_of_mut!(OUTPUT),
        )
    };
    let mut at = 0;
    for chunk in input[..len].chunks(TAG + block) {
        if chunk.len() <= TAG {
            return -1;
        }
        let (tag, sealed) = chunk.split_at(TAG);
        let data = &mut output[at..at + sealed.len()];
        data.copy_from_slice(sealed);
        if !open_box(key, nonce, data, tag) {
            return -1;
        }
        at += sealed.len();
        increment(nonce);
    }
    at as isize
}

/// The key stream of the box, after the key of its Poly1305 tag: the first
/// 32 bytes of the key stream of XSalsa20, as NaCl secretbox.
fn box_stream(key: &[u8; 32], nonce: &[u8; 24]) -> (salsa::KeyStream, Poly1305) {
    let mut stream = salsa::KeyStream::xsalsa20(key, nonce);
    let mut tag_key = [0u8; 32];
    stream.take(&mut tag_key);
    let mac = Poly1305::new(Key::from_slice(&tag_key));
    // SAFETY: the pointer is to a local array, and the write clears it.
    unsafe { core::ptr::write_volatile(&mut tag_key, [0u8; 32]) };
    (stream, mac)
}

/// Encrypts the data in place, and gives its tag.
fn seal_box(key: &[u8; 32], nonce: &[u8; 24], data: &mut [u8]) -> [u8; TAG] {
    let (mut stream, mac) = box_stream(key, nonce);
    stream.apply(data);
    mac.compute_unpadded(data).into()
}

/// Decrypts the data in place when the tag is the tag of the data. The
/// compare of the tags takes the same time for each tag.
fn open_box(key: &[u8; 32], nonce: &[u8; 24], data: &mut [u8], tag: &[u8]) -> bool {
    let (mut stream, mac) = box_stream(key, nonce);
    let expected = mac.compute_unpadded(data);
    if !bool::from(expected.as_slice().ct_eq(tag)) {
        return false;
    }
    stream.apply(data);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_secretbox::aead::AeadInPlace;
    use crypto_secretbox::{Nonce, XSalsa20Poly1305};

    /// Bytes that are not all the same, with no random source.
    fn bytes(size: usize, seed: u32) -> Vec<u8> {
        let mut x = seed.wrapping_mul(0x9e37_79b9) | 1;
        (0..size)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }

    #[test]
    fn boxes_are_the_boxes_of_crypto_secretbox() {
        let sizes = [
            0, 1, 31, 32, 33, 63, 64, 65, 223, 224, 225, 255, 256, 257, 1000, 65536,
        ];
        for (index, &size) in sizes.iter().enumerate() {
            let key: [u8; 32] = bytes(32, index as u32).try_into().unwrap();
            let mut nonce: [u8; 24] = bytes(24, 100 + index as u32).try_into().unwrap();
            // A nonce whose counter of blocks is near a carry.
            if index % 2 == 1 {
                nonce[16..].copy_from_slice(&[0xff; 8]);
            }
            let plain = bytes(size, 200 + index as u32);

            let mut ours = plain.clone();
            let tag = seal_box(&key, &nonce, &mut ours);
            let mut theirs = plain.clone();
            let mac = XSalsa20Poly1305::new(&key.into())
                .encrypt_in_place_detached(Nonce::from_slice(&nonce), b"", &mut theirs)
                .unwrap();
            assert_eq!(ours, theirs, "the data of {size} bytes");
            assert_eq!(&tag[..], &mac[..], "the tag of {size} bytes");

            assert!(open_box(&key, &nonce, &mut ours, &tag));
            assert_eq!(ours, plain);
            if size > 0 {
                let mut bad = theirs.clone();
                bad[size / 2] ^= 1;
                assert!(!open_box(&key, &nonce, &mut bad, &tag));
            }
            let mut bad_tag = tag;
            bad_tag[0] ^= 0x80;
            assert!(!open_box(&key, &nonce, &mut theirs, &bad_tag));
        }
    }

    #[test]
    fn the_key_stream_is_the_same_in_parts_of_each_size() {
        let key = [7u8; 32];
        let nonce = [9u8; 24];
        let mut whole = vec![0u8; 1000];
        salsa::KeyStream::xsalsa20(&key, &nonce).apply(&mut whole);
        for part in [1, 3, 31, 64, 100, 255, 256, 257] {
            let mut stream = salsa::KeyStream::xsalsa20(&key, &nonce);
            let mut parts = vec![0u8; 1000];
            for chunk in parts.chunks_mut(part) {
                stream.apply(chunk);
            }
            assert_eq!(parts, whole, "parts of {part} bytes");
        }
    }
}
