#!/bin/sh
# Builds ../secretbox.wasm from the crate in this folder. The compiler comes
# from rust-toolchain.toml.
set -eu
cd "$(dirname "$0")"
cargo build --release --locked --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/secretbox.wasm ../secretbox.wasm
