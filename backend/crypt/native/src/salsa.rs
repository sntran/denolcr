//! XSalsa20, with 4 blocks of Salsa20 at a time in the SIMD of WebAssembly.

/// The constant words of Salsa20: "expand 32-byte k".
const SIGMA: [u32; 4] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574];

/// The size of a block of Salsa20.
pub const BLOCK: usize = 64;

/// The key words of a 32-byte key, in little-endian.
fn words(bytes: &[u8]) -> [u32; 8] {
    let mut out = [0u32; 8];
    for (index, word) in out.iter_mut().enumerate() {
        let at = index * 4;
        *word = u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    }
    out
}

/// The 20 rounds of Salsa20 on one state.
fn rounds(x: &mut [u32; 16]) {
    macro_rules! qr {
        ($a:expr, $b:expr, $c:expr, $d:expr) => {
            x[$b] ^= x[$a].wrapping_add(x[$d]).rotate_left(7);
            x[$c] ^= x[$b].wrapping_add(x[$a]).rotate_left(9);
            x[$d] ^= x[$c].wrapping_add(x[$b]).rotate_left(13);
            x[$a] ^= x[$d].wrapping_add(x[$c]).rotate_left(18);
        };
    }
    for _ in 0..10 {
        qr!(0, 4, 8, 12);
        qr!(5, 9, 13, 1);
        qr!(10, 14, 2, 6);
        qr!(15, 3, 7, 11);
        qr!(0, 1, 2, 3);
        qr!(5, 6, 7, 4);
        qr!(10, 11, 8, 9);
        qr!(15, 12, 13, 14);
    }
}

/// HSalsa20: the key of XSalsa20 from the key and the first 16 bytes of the
/// nonce.
pub fn hsalsa20(key: &[u8; 32], input: &[u8]) -> [u32; 8] {
    let k = words(key);
    let mut n = [0u32; 4];
    for (index, word) in n.iter_mut().enumerate() {
        let at = index * 4;
        *word = u32::from_le_bytes([input[at], input[at + 1], input[at + 2], input[at + 3]]);
    }
    let mut x = [
        SIGMA[0], k[0], k[1], k[2], k[3], SIGMA[1], n[0], n[1], n[2], n[3], SIGMA[2], k[4], k[5],
        k[6], k[7], SIGMA[3],
    ];
    rounds(&mut x);
    [x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]]
}

/// The key stream of Salsa20 with a key, a nonce of 8 bytes, from a block.
pub struct KeyStream {
    state: [u32; 16],
    buffer: [u8; 4 * BLOCK],
    used: usize,
}

impl KeyStream {
    /// The key stream of XSalsa20 for a key and a nonce of 24 bytes, from
    /// its first byte.
    pub fn xsalsa20(key: &[u8; 32], nonce: &[u8; 24]) -> Self {
        let k = hsalsa20(key, &nonce[..16]);
        let n0 = u32::from_le_bytes([nonce[16], nonce[17], nonce[18], nonce[19]]);
        let n1 = u32::from_le_bytes([nonce[20], nonce[21], nonce[22], nonce[23]]);
        let state = [
            SIGMA[0], k[0], k[1], k[2], k[3], SIGMA[1], n0, n1, 0, 0, SIGMA[2], k[4], k[5], k[6],
            k[7], SIGMA[3],
        ];
        KeyStream {
            state,
            buffer: [0; 4 * BLOCK],
            used: 4 * BLOCK,
        }
    }

    /// Fills the buffer with the next 4 blocks, and moves the counter.
    fn refill(&mut self) {
        blocks4(&self.state, &mut self.buffer);
        let counter = (u64::from(self.state[9]) << 32 | u64::from(self.state[8])).wrapping_add(4);
        self.state[8] = counter as u32;
        self.state[9] = (counter >> 32) as u32;
        self.used = 0;
    }

    /// Puts the next bytes of the key stream in `out`.
    pub fn take(&mut self, out: &mut [u8]) {
        for byte in out.iter_mut() {
            if self.used == self.buffer.len() {
                self.refill();
            }
            *byte = self.buffer[self.used];
            self.used += 1;
        }
    }

    /// XORs the next bytes of the key stream into `data`.
    pub fn apply(&mut self, data: &mut [u8]) {
        let mut data = data;
        // The rest of the buffer.
        let rest = (self.buffer.len() - self.used).min(data.len());
        for (byte, key) in data[..rest].iter_mut().zip(&self.buffer[self.used..]) {
            *byte ^= key;
        }
        self.used += rest;
        data = &mut data[rest..];
        // Whole groups of 4 blocks, then the end.
        while !data.is_empty() {
            self.refill();
            let size = data.len().min(self.buffer.len());
            for (byte, key) in data[..size].iter_mut().zip(&self.buffer[..size]) {
                *byte ^= key;
            }
            self.used = size;
            data = &mut data[size..];
        }
    }
}

/// Writes 4 blocks of Salsa20 from the state: the counter of block `i` is
/// the counter of the state plus `i`.
#[cfg(target_arch = "wasm32")]
fn blocks4(state: &[u32; 16], out: &mut [u8; 4 * BLOCK]) {
    use core::arch::wasm32::*;

    let counter = u64::from(state[9]) << 32 | u64::from(state[8]);
    let lanes: [u64; 4] = [
        counter,
        counter.wrapping_add(1),
        counter.wrapping_add(2),
        counter.wrapping_add(3),
    ];
    let mut input = [u32x4_splat(0); 16];
    for (index, word) in input.iter_mut().enumerate() {
        *word = u32x4_splat(state[index]);
    }
    input[8] = u32x4(
        lanes[0] as u32,
        lanes[1] as u32,
        lanes[2] as u32,
        lanes[3] as u32,
    );
    input[9] = u32x4(
        (lanes[0] >> 32) as u32,
        (lanes[1] >> 32) as u32,
        (lanes[2] >> 32) as u32,
        (lanes[3] >> 32) as u32,
    );
    let mut x = input;

    macro_rules! rotl {
        ($v:expr, $n:literal) => {
            v128_or(u32x4_shl($v, $n), u32x4_shr($v, 32 - $n))
        };
    }
    macro_rules! qr {
        ($a:expr, $b:expr, $c:expr, $d:expr) => {
            x[$b] = v128_xor(x[$b], rotl!(u32x4_add(x[$a], x[$d]), 7));
            x[$c] = v128_xor(x[$c], rotl!(u32x4_add(x[$b], x[$a]), 9));
            x[$d] = v128_xor(x[$d], rotl!(u32x4_add(x[$c], x[$b]), 13));
            x[$a] = v128_xor(x[$a], rotl!(u32x4_add(x[$d], x[$c]), 18));
        };
    }
    for _ in 0..10 {
        qr!(0, 4, 8, 12);
        qr!(5, 9, 13, 1);
        qr!(10, 14, 2, 6);
        qr!(15, 3, 7, 11);
        qr!(0, 1, 2, 3);
        qr!(5, 6, 7, 4);
        qr!(10, 11, 8, 9);
        qr!(15, 12, 13, 14);
    }
    for index in 0..16 {
        x[index] = u32x4_add(x[index], input[index]);
    }
    // Lane `i` of word `j` is the word `j` of block `i`: each group of 4
    // words turns, then goes to its place in each block.
    for group in 0..4 {
        let [a, b, c, d] = [
            x[4 * group],
            x[4 * group + 1],
            x[4 * group + 2],
            x[4 * group + 3],
        ];
        let t0 = i32x4_shuffle::<0, 4, 1, 5>(a, b);
        let t1 = i32x4_shuffle::<0, 4, 1, 5>(c, d);
        let t2 = i32x4_shuffle::<2, 6, 3, 7>(a, b);
        let t3 = i32x4_shuffle::<2, 6, 3, 7>(c, d);
        let rows = [
            i64x2_shuffle::<0, 2>(t0, t1),
            i64x2_shuffle::<1, 3>(t0, t1),
            i64x2_shuffle::<0, 2>(t2, t3),
            i64x2_shuffle::<1, 3>(t2, t3),
        ];
        for (block, row) in rows.iter().enumerate() {
            let at = block * BLOCK + group * 16;
            // SAFETY: `at + 16` is at most the size of `out`.
            unsafe { v128_store(out.as_mut_ptr().add(at).cast(), *row) };
        }
    }
}

/// Writes 4 blocks of Salsa20 from the state, with no SIMD: for the tests
/// on the machine of the build.
#[cfg(not(target_arch = "wasm32"))]
fn blocks4(state: &[u32; 16], out: &mut [u8; 4 * BLOCK]) {
    let counter = u64::from(state[9]) << 32 | u64::from(state[8]);
    for block in 0..4 {
        let mut input = *state;
        let value = counter.wrapping_add(block as u64);
        input[8] = value as u32;
        input[9] = (value >> 32) as u32;
        let mut x = input;
        rounds(&mut x);
        for index in 0..16 {
            let word = x[index].wrapping_add(input[index]);
            let at = block * BLOCK + index * 4;
            out[at..at + 4].copy_from_slice(&word.to_le_bytes());
        }
    }
}
