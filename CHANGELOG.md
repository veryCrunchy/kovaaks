# Changelog

## [0.3.0](https://github.com/veryCrunchy/kovaaks/compare/v0.2.3...v0.3.0) (2026-02-25)


### Features

* add scale/resize support to DraggableHUD ([84242b4](https://github.com/veryCrunchy/kovaaks/commit/84242b4611312f77a3a5e1f2e76bbf8e865d480d))
* expand StatsWindow with new metrics, charts, and live feedback hook ([4f172f2](https://github.com/veryCrunchy/kovaaks/commit/4f172f26a2ecf80b28b3fb7746e4b4047a8500fe))
* **ocr:** per-field stats OCR with idle feedback suppression ([3bc3749](https://github.com/veryCrunchy/kovaaks/commit/3bc37499b1b14f199daeff2c13c5d233b6a70d01))
* **overlay:** StatsHUD, DebugStatsOCR, LiveFeedbackToast, PostSessionOverview ([632f60a](https://github.com/veryCrunchy/kovaaks/commit/632f60acfbabb0c08a8e396b0075ae676f920fa1))
* **settings:** unified region picker with per-field stats regions ([d87c821](https://github.com/veryCrunchy/kovaaks/commit/d87c8216ce5fc2506b03a4e78de775eb1417ed56))
* **types:** add StatsFieldRegions and per-field types ([2603901](https://github.com/veryCrunchy/kovaaks/commit/2603901ae492def0867f17ee31e62760a11d0454))


### Bug Fixes

* sync selected_friend to settings state when opponent changes ([df3c18e](https://github.com/veryCrunchy/kovaaks/commit/df3c18e8deca4c995c8d89de47188a148efa3e18))
* use IDLE instead of WAITING label when no metrics available ([2200026](https://github.com/veryCrunchy/kovaaks/commit/220002674b11415d788228fff84c588e6da124f7))

## [0.2.3](https://github.com/veryCrunchy/kovaaks/compare/v0.2.2...v0.2.3) (2026-02-25)


### Bug Fixes

* remove apostrophe from productName to fix NSIS build ([152f6b2](https://github.com/veryCrunchy/kovaaks/commit/152f6b2892580815f47e7d6e4046302ad3f9afea))

## [0.2.2](https://github.com/veryCrunchy/kovaaks/compare/v0.2.1...v0.2.2) (2026-02-25)


### Bug Fixes

* downgrade @tauri-apps/cli version to 2.9.4 in package.json and pnpm-lock.yaml ([55b0713](https://github.com/veryCrunchy/kovaaks/commit/55b07131179124980afb320f82370da4117c7e9e))

## [0.2.1](https://github.com/veryCrunchy/kovaaks/compare/v0.2.0...v0.2.1) (2026-02-25)


### Bug Fixes

* update @tauri-apps/cli version to 2.9.6 in package.json and pnpm-lock.yaml ([1614258](https://github.com/veryCrunchy/kovaaks/commit/1614258806848c042fc630a49cb547c8f648bbd3))

## [0.2.0](https://github.com/veryCrunchy/kovaaks/compare/kovaaks-overlay-v0.1.0...kovaaks-overlay-v0.2.0) (2026-02-25)


### Features

* add CI and Release workflows for automated builds and deployments ([3045860](https://github.com/veryCrunchy/kovaaks/commit/30458609aaa38b86723d5eac725863fefa830e64))
* add initial Tauri configuration for KovaaK's Overlay ([590ecec](https://github.com/veryCrunchy/kovaaks/commit/590ececf4d199658a907aad078dcabe7d0443352))
* app shell, settings persistence and region picker ([6d8fc7c](https://github.com/veryCrunchy/kovaaks/commit/6d8fc7c3a006d82e4c325c0c5bfd1bf95f0e0d9b))
* CSV file watcher for session start/end detection ([75a303c](https://github.com/veryCrunchy/kovaaks/commit/75a303c0ea74a9867c8f4e5408b8202625493c6d))
* in-app log viewer and auto-updater ([4f7741e](https://github.com/veryCrunchy/kovaaks/commit/4f7741e41821a20a34c8fb3b39fe66287ff2961f))
* KovaaK's API client, VS Mode, and friend score comparison ([dc63765](https://github.com/veryCrunchy/kovaaks/commit/dc6376573ab7d140adb51729dce3f867a54e821a))
* local scenario index with fuzzy OCR correction and validation cache ([e18c086](https://github.com/veryCrunchy/kovaaks/commit/e18c0867e47fd9891286813eeb424bb4edf2981e))
* mouse hook, smoothness metrics, and live HUD ([eee64a9](https://github.com/veryCrunchy/kovaaks/commit/eee64a9703118a1a21791a501a56f688d01dc1ea))
* screen capture and OCR via Windows.Media.Ocr ([a1e2010](https://github.com/veryCrunchy/kovaaks/commit/a1e2010826730bd85b1d927fb537bf77806ae933))
* session history store and stats analytics window ([1f343bd](https://github.com/veryCrunchy/kovaaks/commit/1f343bdcbe483c43cf7bdf900647772e9b03e2e0))
* window tracker — follow KovaaK's focus, assert TOPMOST overlay ([84cedc3](https://github.com/veryCrunchy/kovaaks/commit/84cedc35733291df432d61031887c6eb8424645f))
