#!/bin/sh
# Builds ../secretbox.wasm from the crate in this folder. The compiler comes
# from rust-toolchain.toml, and the versions of the crates from Cargo.lock.
#
# The flags:
# - The SIMD of WebAssembly: Node.js, Deno, Bun and workerd have it.
# - The paths of the build do not go into the module: the folder of the
#   crates of cargo becomes /cargo, and this folder becomes /crate. Thus each
#   machine builds the same bytes, and CI can compare them.
set -eu
cd "$(dirname "$0")"
cargo_home=${CARGO_HOME:-$HOME/.cargo}
separator=$(printf '\037')
CARGO_ENCODED_RUSTFLAGS="-Ctarget-feature=+simd128${separator}"
CARGO_ENCODED_RUSTFLAGS="${CARGO_ENCODED_RUSTFLAGS}--remap-path-prefix=${cargo_home}=/cargo${separator}"
CARGO_ENCODED_RUSTFLAGS="${CARGO_ENCODED_RUSTFLAGS}--remap-path-prefix=$(pwd)=/crate"
export CARGO_ENCODED_RUSTFLAGS
cargo build --release --locked --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/secretbox.wasm ../secretbox.wasm
