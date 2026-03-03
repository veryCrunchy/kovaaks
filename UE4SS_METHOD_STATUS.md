# UE4SS Method Status (KovaaksBridgeMod)

Last updated: 2026-03-02
Scope: `ue4ss-mod/src/KovaaksBridgeMod.cpp` runtime data collection paths.

## Known Working Methods

| Method | Status | Notes |
|---|---|---|
| Direct pull from `PerformanceIndicatorsStateReceiver` (`Get_*_ValueOr/ValueElse`) for shots/hits | Working | `pull_shots_fired_total` and `pull_shots_hit_total` are live and match gameplay trends. |
| Direct pull from `PerformanceIndicatorsStateReceiver` for damage + SPM | Working | `pull_damage_done`, `pull_damage_possible`, `pull_score_per_minute` produce usable live values. |
| Change-only event emission | Working | Emission dedupe and zero suppression reduce spam and transient clobbering. |
| Scenario/native score struct probing (`ScenarioStateReceiver` + `StatsManager`) | Working (partial confidence) | Score now frequently resolves to non-zero (`pull_score_total`) from non-state sources. |
| Extended `ScoreNative` field parsing | Working (field-dependent) | Parser now reads `Accuracy`, `KillEfficiency`, `TimeRemaining`, `DistanceTraveled`, `MBS`, `AverageTimeDilationModifier`, `AverageTargetSizeModifier`, and bool multipliers (`MultAverageTimeDilationModifier`, `MultAverageTargetSizeModifier`) when present. |
| StatsManager numeric property probe (`stats_prop`) | Added for validation | Change-only non-UI property stream to detect live score-like numeric fields when native struct calls are zeroed. |
| ScenarioManager time fallback (`GetChallengeTimeElapsed/Remaining/Length`) | Added for validation | Non-UI runtime time source to backfill `seconds` and improve derived score when PI receiver seconds stay at `0`. |
| Runtime flag refresh + file/env toggles | Working | Flags are detected and refreshed at runtime; debug output confirms active set. |
| UI field polling path | Working | Captures `SessionStatistics` text values and derived shot/hit deltas. |
| Analytics lifecycle hooks (`OnChallengeStarted/Restarted/Quit/Completed`) | Working | These events were observed firing reliably. |

## Partially Working / Unstable Methods

| Method | Status | Failure pattern seen |
|---|---|---|
| `PerformanceIndicatorsStateReceiver` score getters (`Get_Score*`, `Receive_Score*`) | Unstable | Returns `0` and `999`-like defaults; not reliable as primary live score source. |
| Derived score (`SPM * seconds / 60`) | Usable fallback only | Good when both inputs are fresh; invalid when `seconds`/`spm` transiently reset to `0`. |
| UI text score fallback | Usable but noisy | Can include placeholder transitions and stale text; should remain fallback only. |
| Receiver reselect/probe | Mostly working | Can still log probe candidates with `signal=0` while other streams are live. |

## Confirmed Not Working (Current Approach)

| Method | Status | Evidence/impact |
|---|---|---|
| Treating state score path as authoritative | Not working | Causes clobbering of better score with `0`/default-like values. |
| Numeric property auto-binding on receiver class | Not working | Repeated `bound 0 numeric receiver properties` logs. |
| Wide class probe hooks during normal play | Not viable for routine use | Causes heavy spam and can induce frame drops/freezes. |

## Crash/Instability Findings

| Toggle/Path | Status |
|---|---|
| Native UFunction hooks (`KOVAAKS_NATIVE_HOOKS`) | User-confirmed crash-prone; keep OFF for normal debugging |
| ProcessEvent detour (`Enable PE hook`) | User observed crash configurations; keep opt-in and isolated |
| ProcessInternal / ProcessLocalScript hooks | Unsafe experimental paths; keep OFF unless explicitly isolating |
| Class probe hooks | Heavy and unstable for live sessions; diagnostic-only |

## Not Tried Yet (or Not Fully Validated)

| Candidate method | Why it is worth trying |
|---|---|
| Targeted hook on specific `ScenarioStateReceiver:Send_ChallengeScore` only (no wide/native hook set) | Might capture authoritative score writes with lower crash surface than broad hooks. |
| Targeted hook on `StatsManager:CalculateScore` return at challenge-end transition only | Could provide authoritative final/live score snapshots with low call volume. |
| Poll additional `ScoreNative` owners (`MetaGameplayHud:DisplayChallengeEndScreen:Score`, `ChallengeEndScore_C:NativeScore`) with strict lifecycle gating | Could yield high-confidence score around end-screen without UI text parsing. |
| Add source confidence scoring based on temporal coherence (monotonic/expected bounds per scenario type) | Could auto-reject outliers like `999` and sudden zero resets. |
| Add per-source cooldown/hold logic for score (not only per-metric zero suppression) | Prevents rapid source flapping in mixed-value ticks. |
| Validate score paths separately for timed vs endless scenarios | Some score paths likely scenario-type dependent. |

## Recommended Debug Flag Profile (Current)

| Flag | Value |
|---|---|
| `Enable PE hook` | OFF |
| `Force disable PE` | OFF |
| `Discovery mode` | OFF |
| `Log all events` | OFF |
| `Object debug` | OFF |
| `Non-UI probe` | ON |
| `Hook ProcessInternal` | OFF |
| `Hook ProcessLocalScript` | OFF |
| `Class probe hooks` | OFF |
| `Safe mode` | OFF |
| `No Rust bridge` | OFF |

This profile is the current lowest-noise, lowest-risk setup for validating direct pull quality.

## Current Practical Conclusion

- Best live data path right now is direct pull for shots/hits/SPM/damage from `PerformanceIndicatorsStateReceiver`.
- Live score should not trust `state_get_score` directly.
- Score should come from ranked sources (`scenario/native`, `stats/native`, then derived fallback) with state-score path treated as weak/noisy.
