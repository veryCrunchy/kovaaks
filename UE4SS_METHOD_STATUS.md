# UE4SS Method Status (Non-UI)

Last updated: 2026-03-03  
Scope: non-UI data paths in `ue4ss-mod/src/KovaaksBridgeMod.cpp` and `ue4ss-mod/src/KovaaksBridgeMod.production.cpp`.

## Dump-Verified Method Contract (2026-03-04)

Authoritative dump sources used:

- `ue4ss-mod/UHTHeaderDump/KovaaKFramework/Public/PerformanceIndicatorsStateReceiver.h`
- `ue4ss-mod/UHTHeaderDump/KovaaKFramework/Public/ScenarioStateReceiver.h`
- `ue4ss-mod/UHTHeaderDump/GameSkillsTrainer/Public/ScenarioManager.h`
- `ue4ss-mod/CXXHeaderDump/KovaaKProfileModels.hpp` (`FScoreNative`)
- `ue4ss-mod/UHTHeaderDump/KovaaKCoreModels/Public/EValueElseResult.h`

Key return semantics:

- `*_ValueElse` methods return both `OutValue` and `Result`.
- `EValueElseResult::HasValue = 0`, `Else = 1`.
- Correct usage is: only trust `OutValue` when `Result == HasValue`.
- `*_ValueOr` methods are fallback-safe because `ValueIfNull` is explicit.

Preferred non-UI pull order (core combat metrics):

1. Event/hooks (`Send_*`, gameplay broadcast hooks, native hook callbacks)
2. `PerformanceIndicatorsStateReceiver:Get_*_ValueElse` (accept only `HasValue`)
3. `PerformanceIndicatorsStateReceiver:Get_*_ValueOr` (sentinel `ValueIfNull`)
4. `PerformanceIndicatorsStateReceiver:Receive_*` variants (best-effort)
5. `ScenarioStateReceiver:Get_ChallengeScore_*` (`FScoreNative` snapshot)
6. `StatsManager:CalculateScore` (`FScoreNative` snapshot)
7. `ScenarioManager` timing/state methods
8. UI parsing only when explicit fallback flags are enabled

`FScoreNative` fields verified in dump and consumed by bridge:

- `Score` (`float`)
- `KillCount` (`int32`)
- `ShotsHit` (`int32`)
- `ShotsFired` (`int32`)
- `Accuracy` (`float`)
- `DamageDone` (`float`)
- `DamagePossible` (`float`)
- `DamageEfficiency` (`float`)
- `KillEfficiency` (`float`)
- `TimeRemaining` (`float`)
- `DistanceTraveled` (`float`)
- `MBS` (`float`)
- `AverageTimeDilationModifier` (`float`)
- `AverageTargetSizeModifier` (`float`)
- `MultAverageTimeDilationModifier` (`bool`)
- `MultAverageTargetSizeModifier` (`bool`)

## Latest Run Snapshot (What We Already Tried)

## Lookup Stability Fix (2026-03-03)

Observed issue:

- Runtime reported broad `target missing` with `re-resolved targets count=0` despite class probes proving target functions existed.

Fix applied in `ue4ss-mod/src/KovaaksBridgeMod.cpp`:

- Hardened `find_fn` lookup with canonical and fuzzy matching:
  - strips optional `Function ` prefix
  - supports both `Class:Method` and `Class.Method` variants
  - falls back to owner/member matching against a live indexed function list
- Expanded function index to store alias keys and searchable entries, not exact-path keys only.

Verification status:

- Build compiles and stages successfully.
- Runtime validation pending next game run (expect non-zero `function lookup index built count=...` and non-zero `re-resolved targets count=...`).

### Working (`verdict=good`)

| Metric/Method | Source Fn | Notes |
|---|---|---|
| `class_hook_getchallengetimeremaining` | `/Script/GameSkillsTrainer.ScenarioManager:GetChallengeTimeRemaining` | Stable non-zero timer signal (`NZ%=100`). |
| `class_hook_getchallengequeuetimeremaining` | `/Script/GameSkillsTrainer.ScenarioManager:GetChallengeQueueTimeRemaining` | Stable and non-zero when queue time is active. |
| `class_hook_isinscenario` | `/Script/GameSkillsTrainer.ScenarioManager:IsInScenario` | Useful state gate (`NZ%=91`). |

### Usable But Noisy

| Metric/Method | Source Fn | Why noisy |
|---|---|---|
| `class_hook_isinchallenge` | `/Script/GameSkillsTrainer.ScenarioManager:IsInChallenge` | Return path has unstable/coerced bool-like values; keep as weak signal only. |
| `class_hook_playcurrentscenario` | `/Script/GameSkillsTrainer.ScenarioManager:PlayCurrentScenario` | Sparse samples and non-sensical float payloads. |
| `class_hook_setcurrentscenarioplaytype` | `/Script/GameSkillsTrainer.ScenarioManager:SetCurrentScenarioPlayType` | Very low sample count; unstable return payload. |

### Dead In Current Non-UI Run

| Metric/Method | Source Fn | Failure pattern |
|---|---|---|
| `class_hook_isinscenarioeditor` | `/Script/GameSkillsTrainer.ScenarioManager:IsInScenarioEditor` | `NZ%=0` / always unusable in this run. |
| `class_hook_getcurrentscenario` | `/Script/GameSkillsTrainer.ScenarioManager:GetCurrentScenario` | `NZ%=0` in sampled window. |
| `class_hook_getintrainer` | `/Script/GameSkillsTrainer.GTheMetaGameInstance:GetInTrainer` | No useful variation in sampled window. |
| `class_hook_iscurrentlyinbenchmark` | `/Script/GameSkillsTrainer.ScenarioManager:IsCurrentlyInBenchmark` | No useful variation in sampled window. |
| `class_hook_k2_getsessionsave` | `/Script/GameSkillsTrainer.ScenarioManager:K2_GetSessionSave` | No useful output. |
| `class_hook_cancelchallenge` | `/Script/GameSkillsTrainer.ScenarioManager:CancelChallenge` | No useful output. |
| `class_hook_initializescenario` | `/Script/GameSkillsTrainer.ScenarioManager:InitializeScenario` | No useful output. |
| `pull_source / scenario_score_native` | `/Script/KovaaKFramework.ScenarioStateReceiver:Receive_ChallengeScore` | Dead/zero in sampled run. |
| `pull_source / stats_calculate_score` | `/Script/GameSkillsTrainer.StatsManager:CalculateScore` | Dead/zero in sampled run. |

### Dead Pull Metric Families (Current Snapshot)

The following non-UI pull metric families were tried and observed dead/zero in the snapshot (across `emit_event`, `direct_pull_emit_non_ui`, and/or direct methods like `state_get`):

- `pull_accuracy`
- `pull_average_target_size_modifier`
- `pull_average_time_dilation_modifier`
- `pull_challenge_average_fps`
- `pull_challenge_seconds_total`
- `pull_challenge_tick_count_total`
- `pull_challenge_time_length`
- `pull_damage_done`
- `pull_damage_efficiency`
- `pull_damage_possible`
- `pull_distance_traveled`
- `pull_kill_efficiency`
- `pull_kills_per_second`
- `pull_kills_total`
- `pull_last_challenge_time_remaining`
- `pull_last_score`
- `pull_mbs`
- `pull_mult_average_target_size_modifier`
- `pull_mult_average_time_dilation_modifier`
- `pull_previous_high_score`
- `pull_previous_session_best_score`
- `pull_random_sens_scale`
- `pull_score_per_minute`
- `pull_score_total`
- `pull_seconds_total`
- `pull_session_best_score`
- `pull_shots_fired_total`
- `pull_shots_hit_total`
- `pull_time_remaining`

## Failure Patterns Observed

- `pull_source` logs showed stale `None.None` call contexts for some state-get paths, which explains repeated zero payloads.
- `StatsManager` numeric property auto-bind remains ineffective in observed runs (`bound 0 stats numeric properties`).
- Class hook probes can fire with noisy raw payloads; only a subset is safe to trust.

## Object Dump Gap Check (Untried Methods)

Object dump diff was run against current wired function strings.

- Core methods in dump scope: `366`
- Currently wired core methods: `121`
- Core methods not yet wired: `245`

Breakdown of untried core methods by class:

- `GTheMetaGameInstance`: `108` (mostly account/settings flows, low value for live combat stats)
- `ScenarioStateReceiver`: `48` (high value)
- `ScenarioManager`: `38` (medium/high value)
- `PerformanceIndicatorsStateReceiver`: `32` (high value)
- `GameInstanceStateReceiver`: `10` (medium value)
- `StatsManager`: `5` (medium value)
- `SandboxSessionStats`: `4` (medium value)

Full untried list is tracked here:

- `UE4SS_UNTRIED_CORE_METHODS.md`

## Priority Next Methods (Non-UI Only)

1. `/Script/KovaaKFramework.ScenarioStateReceiver:Send_Seconds`
2. `/Script/KovaaKFramework.ScenarioStateReceiver:Get_Seconds_ValueOr`
3. `/Script/KovaaKFramework.ScenarioStateReceiver:Get_Seconds_ValueElse`
4. `/Script/KovaaKFramework.ScenarioStateReceiver:Get_IsPaused_ValueOr`
5. `/Script/KovaaKFramework.ScenarioStateReceiver:Get_IsEnabled_ValueOr`
6. `/Script/KovaaKFramework.ScenarioStateReceiver:Get_ScenarioPlayType_ValueOr`
7. `/Script/KovaaKFramework.ScenarioStateReceiver:Send_ChallengeScore`
8. `/Script/KovaaKFramework.GameInstanceStateReceiver:Get_GameSeconds_ValueOr`
9. `/Script/GameSkillsTrainer.SandboxSessionStats:GetSessionDisplayTime`
10. `/Script/GameSkillsTrainer.ScenarioManager:NotifyDamageDealt`
11. `/Script/GameSkillsTrainer.ScenarioManager:NotifyPlayerKillCredit`
12. `/Script/GameSkillsTrainer.ScenarioManager:NotifyCharacterDeath`
13. `/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_ScorePerMinute_ValueOr`
14. `/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_Seconds_ValueOr`
15. `/Script/KovaaKFramework.PerformanceIndicatorsStateReceiver:Receive_KillsPerSecond_ValueOr`

## Trial Wiring Added (2026-03-03, Pending Validation)

These non-UI paths were wired in `ue4ss-mod/src/KovaaksBridgeMod.cpp` for runtime trial:

- `PerformanceIndicatorsStateReceiver` receive variants expanded:
  - `Receive_*_ValueOr`, `Receive_*_Single` for shots, hits, kills, seconds, SPM, KPS, damage.
- `ScenarioStateReceiver` wired:
  - `Get/Receive_Seconds_*`
  - `Get/Receive_IsPaused_*`
  - `Get/Receive_IsEnabled_*`
  - `Get/Receive_IsInEditor_*`
  - `Get/Receive_ScenarioPlayType_*`
- `GameInstanceStateReceiver` wired:
  - `Get/Receive_GameSeconds_*`
  - Added object resolver for runtime instance selection.
- `ScenarioManager` / meta wired:
  - `GetChallengeQueueTimeRemaining`
  - `IsInChallenge`, `IsInScenario`, `IsInScenarioEditor`, `IsCurrentlyInBenchmark`
  - `GTheMetaGameInstance:GetInTrainer`

Result status: pending next run verification (no UI fallback).

## Added This Turn (2026-03-03, Pending Validation)

Non-UI event accumulator path was added from native gameplay broadcast methods:

- `/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Send_ShotFired`
- `/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Send_ShotHit`
- `/Script/GameSkillsTrainer.PerformanceIndicatorsBroadcastReceiver:Send_Kill`
- `/Script/GameSkillsTrainer.WeaponParentActor:Send_ShotFired`
- `/Script/GameSkillsTrainer.WeaponParentActor:Send_ShotHit`

What it now emits directly (without UI polling):

- `pull_shots_fired_total` (event-accumulated)
- `pull_shots_hit_total` (event-accumulated)
- `pull_kills_total` (event-accumulated)
- `pull_damage_done` (from `DamageDone` shot-hit param accumulation)
- `pull_damage_possible` (from `DamagePossible` shot-fired param accumulation)
- derived non-UI helpers from those totals:
  - `pull_accuracy`
  - `pull_damage_efficiency`
  - `pull_kills_per_second` (when `seconds_total` is known)

Reset behavior wired:

- reset on challenge lifecycle transitions (`challenge_queued`, `challenge_start`, `challenge_restart`, `challenge_quit`, `challenge_canceled`)
- reset on `Reset_TransientData`

## Regeneration Command

Use this to re-run the core diff inventory:

```bash
rg -o 'Function /Script/(KovaaKFramework|GameSkillsTrainer)\.(PerformanceIndicatorsStateReceiver|ScenarioStateReceiver|StatsManager|ScenarioManager|SandboxSessionStats|GameInstanceStateReceiver|GTheMetaGameInstance):[^ ]+' UE4SS_ObjectDump.txt \
  | sed 's/^Function //' | sort -u > /tmp/kovaaks_dump_core_funcs.txt

rg -o '/Script/(KovaaKFramework|GameSkillsTrainer)\.[^"\)]+' ue4ss-mod/src/KovaaksBridgeMod.cpp ue4ss-mod/src/KovaaksBridgeMod.production.cpp \
  | sed 's/^[^:]*://' | sort -u > /tmp/kovaaks_wired_funcs.txt

comm -23 /tmp/kovaaks_dump_core_funcs.txt /tmp/kovaaks_wired_funcs.txt > /tmp/kovaaks_untried_core_funcs.txt
```
