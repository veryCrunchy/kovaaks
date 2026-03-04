# Migration Roadmap

## Phase 1: Runtime skeleton (done)

- UE4SS C++ mod entrypoint (`main.dll`)
- Rust core FFI bridge (`kovaaks_rust_core.dll`)
- Named pipe event emission parity with existing overlay

## Phase 2: First real gameplay hook (done)

- Registered UE4SS `ProcessEvent` post hook in `KovaaksBridgeMod.cpp`
- Added pointer-resolved `UFunction` targets for score/combat/challenge events
- Emits typed JSON through Rust bridge for live overlay backend forwarding

## Phase 3: Full stat event mapping

- Map all required live events: score, kills, shots_hit, shots_fired, damage_done, damage_possible, challenge lifecycle
- Add scenario start/reset handling
- Add event-rate guardrails and de-duplication

## Phase 4: Mod-level features

- UE4 UI widget injection path
- Config API + runtime toggles
- Versioned compatibility checks per game build
