# ue4ss-rust-core

Rust `cdylib` consumed by the UE4SS C++ shim.

## Exports

- `bridge_init()`
- `bridge_shutdown()`
- `bridge_is_connected()`
- `bridge_emit_i32(const char*, int32_t)`
- `bridge_emit_f32(const char*, float)`
- `bridge_emit_json(const char*)`
- Convenience helpers for `shot_hit`, `shot_fired`, `kill`, challenge events

All exports send newline-delimited JSON to `\\.\\pipe\\kovaaks-bridge`.

## Build

```bash
cargo build --release --target x86_64-pc-windows-msvc
```

Output: `target/x86_64-pc-windows-msvc/release/ue4ss_rust_core.dll`

Deploy this as `kovaaks_rust_core.dll` next to UE4SS runtime files.
