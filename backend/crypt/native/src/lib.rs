//! The blocks of the data of rclone crypt: NaCl secretbox, that is
//! XSalsa20 and Poly1305, for `../secretbox.js`.
//!
//! The module has no imports. JavaScript writes the key, the nonce and the
//! input into the memory of the module, at the addresses that `key`,
//! `nonce` and `input` give. Then `seal` or `open` writes the output at the
//! address that `output` gives. The nonce goes up by 1 for each block, as a
//! number in little-endian bytes, thus JavaScript reads it back for the
//! next call.
#![no_std]

use crypto_secretbox::aead::{AeadInPlace, KeyInit};
use crypto_secretbox::{Nonce, XSalsa20Poly1305};

/// The size of a Poly1305 tag.
const TAG: usize = 16;
/// The size of the input and of the output: 16 boxes of 64 KiB of data.
const SIZE: usize = 16 * (64 * 1024 + TAG);

static mut KEY: [u8; 32] = [0; 32];
static mut NONCE: [u8; 24] = [0; 24];
static mut INPUT: [u8; SIZE] = [0; SIZE];
static mut OUTPUT: [u8; SIZE] = [0; SIZE];

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
    let cipher = XSalsa20Poly1305::new(key.into());
    let mut at = 0;
    for part in input[..len].chunks(block) {
        let (tag, data) = output[at..at + TAG + part.len()].split_at_mut(TAG);
        data.copy_from_slice(part);
        match cipher.encrypt_in_place_detached(Nonce::from_slice(nonce), b"", data) {
            Ok(mac) => tag.copy_from_slice(&mac),
            Err(_) => return 0,
        }
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
    let cipher = XSalsa20Poly1305::new(key.into());
    let mut at = 0;
    for chunk in input[..len].chunks(TAG + block) {
        if chunk.len() <= TAG {
            return -1;
        }
        let (tag, sealed) = chunk.split_at(TAG);
        let data = &mut output[at..at + sealed.len()];
        data.copy_from_slice(sealed);
        let opened =
            cipher.decrypt_in_place_detached(Nonce::from_slice(nonce), b"", data, tag.into());
        if opened.is_err() {
            return -1;
        }
        at += sealed.len();
        increment(nonce);
    }
    at as isize
}
