# Changelog

## [0.8.1](https://github.com/veryCrunchy/kovaaks/compare/v0.8.0...v0.8.1) (2026-02-27)


### Bug Fixes

* **mouse-hook:** reduce input latency by optimizing raw mouse event processing ([57a0432](https://github.com/veryCrunchy/kovaaks/commit/57a043231b383fae47c455e1e3882ddabc5b30c4))
* **window-tracker:** optimize overlay visibility handling and reassert TOPMOST state ([e855e59](https://github.com/veryCrunchy/kovaaks/commit/e855e59ecea341588f4f22cb965ce09c4400ac7a))

## [0.8.0](https://github.com/veryCrunchy/kovaaks/compare/v0.7.0...v0.8.0) (2026-02-27)


### Features

* **api:** add endpoints for fetching best score and scenario details ([61b2529](https://github.com/veryCrunchy/kovaaks/commit/61b2529bfb4fa157cf6d4661dc2fdaa724bf9398))
* **auto-setup:** enhance auto-setup loop with dynamic OCR capture rect and scenario detection ([0937f4e](https://github.com/veryCrunchy/kovaaks/commit/0937f4e2a2c1ad6021c6efa7f162248e85658afa))
* **leaderboard:** add LeaderboardBrowser component for scenario leaderboard display ([b59e47a](https://github.com/veryCrunchy/kovaaks/commit/b59e47a34d0e19d83d6cd25cad37c3a3b24f5d4a))
* **replay:** add replay loading and scenario search functionality ([fcde742](https://github.com/veryCrunchy/kovaaks/commit/fcde742a0d8df1176a09fed336203bc7b437bdfe))
* **replay:** enhance session handling with replay persistence ([e7ca82d](https://github.com/veryCrunchy/kovaaks/commit/e7ca82d3e15ff164fde15164b87ed2cb3f2e0acc))
* **replay:** implement replay storage and management for session data ([8edeb7d](https://github.com/veryCrunchy/kovaaks/commit/8edeb7ddc1b1404eddd0debe1b8782556c3ffc7d))
* **settings:** add tools section with session stats and logs buttons ([c0bbc9a](https://github.com/veryCrunchy/kovaaks/commit/c0bbc9a98d0af4c26c25c1329628ef71e3f12c83))
* **steam-integration:** add Steam user detection and friend import functionality ([5f97502](https://github.com/veryCrunchy/kovaaks/commit/5f97502cc7bb31d4d801da80b7c708e66c12a69a))


### Bug Fixes

* **feedback:** improve clarity of feedback messages for mouse performance ([7e76128](https://github.com/veryCrunchy/kovaaks/commit/7e76128410b2ae3b5a56f1c6b7947587dab0f06d))
* **mouse-path-viewer:** adjust image positioning and sizing for better alignment with canvas ([c249418](https://github.com/veryCrunchy/kovaaks/commit/c249418afbdf960539232a257ad2cf7279515b4d))
* **ocr:** improve OCR reliability across all per-field stat parsers ([b736b09](https://github.com/veryCrunchy/kovaaks/commit/b736b09ebac225329a80349ee7585025857ea463))
* **ocr:** remove hard upper bound on SPM in sanitize_reading function ([262a8da](https://github.com/veryCrunchy/kovaaks/commit/262a8da3248f8990d2c3e761fe3a57ea103477ba))
* **settings:** OCR region cleared on save, visibility not reloaded ([b553b44](https://github.com/veryCrunchy/kovaaks/commit/b553b449eecf49a9d5513c12115a698ac19df207))
* **single-instance:** improve process termination logic for overlay ([3923312](https://github.com/veryCrunchy/kovaaks/commit/3923312af2e5de7d72b2994e4e5535afa14e8e33))
* **stats-overview:** improve language use to be easier to understand ([2942fe2](https://github.com/veryCrunchy/kovaaks/commit/2942fe274b0c7480a14b8f6a90b3959eb35baeb2))
* **stats:** make session stats window visible by default ([b68ea07](https://github.com/veryCrunchy/kovaaks/commit/b68ea0710d22f26ff6030fbb111f3541da2958af))

## [0.7.0](https://github.com/veryCrunchy/kovaaks/compare/v0.6.1...v0.7.0) (2026-02-26)


### Features

* **friend-manager:** add search type toggle for friend addition ([e63426c](https://github.com/veryCrunchy/kovaaks/commit/e63426c25fb6dbc3e805c43bae79024831ea8af5))
* **friend-manager:** enhance friend addition with Steam profile resolution ([158e0f4](https://github.com/veryCrunchy/kovaaks/commit/158e0f486d1c0f2cac13454ab28e9f3a75fa1d8c))
* **mouse-hook:** enhance raw mouse event handling for improved metrics accuracy ([3bcea1f](https://github.com/veryCrunchy/kovaaks/commit/3bcea1f3ae3021413d46a587d4f20a6b42199895))


### Bug Fixes

* **FieldGroup:** change description type from string to React.ReactNode ([8466e7e](https://github.com/veryCrunchy/kovaaks/commit/8466e7e8c39f4ac72ffd8cc828e42a565084d80b))

## [0.6.1](https://github.com/veryCrunchy/kovaaks/compare/v0.6.0...v0.6.1) (2026-02-25)


### Bug Fixes

* **mouse-hook:** add Windows Raw Input support for accurate mouse tracking ([9e7e346](https://github.com/veryCrunchy/kovaaks/commit/9e7e34641331ee424198ab6bc9c4d6437ad3279d))

## [0.6.0](https://github.com/veryCrunchy/kovaaks/compare/v0.5.0...v0.6.0) (2026-02-25)


### Features

* **mouse-path-viewer:** add mouse path visualization and sensitivity suggestions ([be7ecee](https://github.com/veryCrunchy/kovaaks/commit/be7ecee32c7a204a85a46bfd955d075c5b749812))
* **mouse-path:** raw cursor path recording for post-session visualisation ([58220e1](https://github.com/veryCrunchy/kovaaks/commit/58220e1ff804ffa5be23381ffab27c609614c45a))
* **screen-recorder:** low-res JPEG session recording for mouse-path underlay ([d2fad2d](https://github.com/veryCrunchy/kovaaks/commit/d2fad2df05450bcb4d8ac3ddaf58a0e9098d33c1))
* **session:** add commands to retrieve session mouse data, raw positions, and screen frames ([e50cfc6](https://github.com/veryCrunchy/kovaaks/commit/e50cfc60c8a571af341b5df445a43a21253165bb))
* update kovaaks-overlay version and adjust monitor rectangle synchronization ([0603190](https://github.com/veryCrunchy/kovaaks/commit/0603190c1f39b9d9c87df4bd4e4c6cede812239e))


### Bug Fixes

* **scenario:** strip challenge-mode suffixes; migrate existing sessions ([d916fce](https://github.com/veryCrunchy/kovaaks/commit/d916fcea17d7d28f786941db8dfc0cdae8ddf645))
* **settings:** add serde defaults, log deser errors, migrate region→spm on startup ([d7a831e](https://github.com/veryCrunchy/kovaaks/commit/d7a831e919925ff3555850327c9d1bda54404d78))
* **stats-ocr:** fix damage parse for X/Y format, prevent MultiHit misclassification ([bb3499b](https://github.com/veryCrunchy/kovaaks/commit/bb3499b2a691f6ce529392253b53d78a5a103236))

## [0.5.0](https://github.com/veryCrunchy/kovaaks/compare/v0.4.0...v0.5.0) (2026-02-25)


### Features

* add session stats tab and integrate StatsWindow component ([6efbe2f](https://github.com/veryCrunchy/kovaaks/commit/6efbe2f2b1d00f501e2fcc6ed19c95773c6e3a94))
* **animation:** add spin and pulse keyframes for animations ([74fa88f](https://github.com/veryCrunchy/kovaaks/commit/74fa88fc6aeaaaf90a2438e239d2821e17fe7265))
* **auto-setup:** add auto-setup mode and HUD integration ([90a9c6c](https://github.com/veryCrunchy/kovaaks/commit/90a9c6c4b84e24f035898d8f316f039daf7f6dff))
* **ocr:** add support for capturing words with bounding boxes ([e212e13](https://github.com/veryCrunchy/kovaaks/commit/e212e13d7b27a0fd58946ad962ab846963cab5b9))
* **spm:** deprecate legacy region field, migrate to stats_field_regions.spm ([8a0d071](https://github.com/veryCrunchy/kovaaks/commit/8a0d07117e8bef260fc76d958bd77d6c389c971c))


### Bug Fixes

* **auto-setup:** remove same-row filter that dropped vertically-stacked fields ([a6b8e64](https://github.com/veryCrunchy/kovaaks/commit/a6b8e64f4e56dcfec1d221acd604177330f80177))
* enable createUpdaterArtifacts to produce .nsis.zip.sig for updater ([f49fb65](https://github.com/veryCrunchy/kovaaks/commit/f49fb6558f9254cca9384e7d65d47913226464da))
* remove unused trayIcon configuration from tauri.conf.json ([19a3c76](https://github.com/veryCrunchy/kovaaks/commit/19a3c76a8750cfba80698a21004e334a3ca1b85b))
* update settings panel to be a floating overlay with backdrop dismiss ([c5af49e](https://github.com/veryCrunchy/kovaaks/commit/c5af49eab12698428375d4f83eea3135d0d259df))

## [0.4.0](https://github.com/veryCrunchy/kovaaks/compare/v0.3.0...v0.4.0) (2026-02-25)


### Features

* add README with features, installation instructions, and screenshots; update kovaaks-overlay version to 0.2.3 ([ba8b69b](https://github.com/veryCrunchy/kovaaks/commit/ba8b69b53218272c7c348bd8f9a898b6e3f95085))


### Bug Fixes

* explicitly pass --target to tauri-action so updater sig is found ([bcf9319](https://github.com/veryCrunchy/kovaaks/commit/bcf9319060803047f0aa782b167b8b86aecf41e9))

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
