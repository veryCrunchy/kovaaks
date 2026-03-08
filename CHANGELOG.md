# Changelog

## [1.0.0](https://github.com/veryCrunchy/kovaaks/compare/v0.8.1...v1.0.0) (2026-03-08)


### ⚠ BREAKING CHANGES

* remove OCR pipeline and rebrand app as AimMod

### Features

* Add additional fields to BridgeCommand and improve RustBridge startup logic ([1c6b558](https://github.com/veryCrunchy/kovaaks/commit/1c6b55873e5e1275ece1fe513bfa6ec050121ff5))
* Add caching for UE4SS template and payload pipeline artifacts ([1a3494a](https://github.com/veryCrunchy/kovaaks/commit/1a3494a9c3d7d8774ddd4b2fd76174172c9f0008))
* Add challenge lifecycle management and refine game state derivation ([02163e8](https://github.com/veryCrunchy/kovaaks/commit/02163e88d85ee9c573f184c9f144b14ed060a85c))
* Add CSV import functionality for session history ([1f4b1a5](https://github.com/veryCrunchy/kovaaks/commit/1f4b1a5fffc3704141e5a3379e2bfb08273342bd))
* Add Discord RPC integration for presence updates ([919e235](https://github.com/veryCrunchy/kovaaks/commit/919e235e24c8465ba441273d93b493c2b2acfab3))
* Add functions for managing Git repository references and logging revisions in dev pipeline scripts ([9244f1a](https://github.com/veryCrunchy/kovaaks/commit/9244f1a261fa86d6f9d631e7f0092d2c82594195))
* Add lifecycle event handling and stale event filtering in live score ([1508bf9](https://github.com/veryCrunchy/kovaaks/commit/1508bf93783c9741ac7ed4aae6ae808db47a9e31))
* Add lifecycle start alignment hint for improved signal inference ([baaeb9c](https://github.com/veryCrunchy/kovaaks/commit/baaeb9c8d5c8eb5b3218538d78f72ab4f984a6f6))
* Add live metric hooks and related functionality for enhanced metrics tracking ([83da1aa](https://github.com/veryCrunchy/kovaaks/commit/83da1aac15fdfb5fa3fe93e403d55f80d0f106b2))
* Add logging for built and staged payload hashes in dev and prod workflows ([e8143a7](https://github.com/veryCrunchy/kovaaks/commit/e8143a76a2f2af3981262c330738c6464334db25))
* Add pagination and recent scenarios retrieval to session store ([695ab7c](https://github.com/veryCrunchy/kovaaks/commit/695ab7c7596211f8fa20bb9e0998c837de04b363))
* Add replay playback frame structure and extend bridge command with new fields ([0a3fd9c](https://github.com/veryCrunchy/kovaaks/commit/0a3fd9cef76cdac93c1674cf3f41faa5a23209bb))
* Add scenario sorting functionality to StatsWindow ([78ea49b](https://github.com/veryCrunchy/kovaaks/commit/78ea49ba3a3e247a12f04f8938c9ec71bef093a3))
* Add scenario subtype classification to stats panel and database schema ([67b5db6](https://github.com/veryCrunchy/kovaaks/commit/67b5db6648c01cb8b174267513e0b4e2146096fa))
* Add scenario subtype to stats panel and telemetry interfaces ([3b23513](https://github.com/veryCrunchy/kovaaks/commit/3b23513360d49e41b0e8f8adaf0fd600cdf63076))
* Add scripts for syncing UE4SS payload and settings ([9a53cd2](https://github.com/veryCrunchy/kovaaks/commit/9a53cd2c16ee5cc0c3f9ae275adb44856b2f62cb))
* Add session replay payload handling and SQLite persistence ([4eed603](https://github.com/veryCrunchy/kovaaks/commit/4eed603ab387cdee798743ca16cef0ae86099d31))
* Add session run summary and timeline commands ([21d740d](https://github.com/veryCrunchy/kovaaks/commit/21d740d2fe4dfb99409eb9f1b753c26b2dbb0300))
* Add session shot telemetry retrieval and database schema update ([27f576d](https://github.com/veryCrunchy/kovaaks/commit/27f576d92060182334880257016d898875de419d))
* Add shot target telemetry emission and JSON snapshot handling ([df8accb](https://github.com/veryCrunchy/kovaaks/commit/df8accbb474fbc26db75df1ff8760b0cc46e1e4c))
* Add shot telemetry interfaces and update stats export ([b4994cc](https://github.com/veryCrunchy/kovaaks/commit/b4994cc214e6f12c90ccecd57a035fdb6590e86c))
* Add shot telemetry structures and processing functions ([107d0bd](https://github.com/veryCrunchy/kovaaks/commit/107d0bd834894d488cc21ba20a969754018ce78e))
* Add shot telemetry tracking and summary to ReplayTab ([0ebe0af](https://github.com/veryCrunchy/kovaaks/commit/0ebe0af996baca6863069a32d341bc0cdce3de51))
* Add stats panel snapshot functionality for session tracking ([6431cbd](https://github.com/veryCrunchy/kovaaks/commit/6431cbd0e094a116f39ae488ebed38f62e6e9a12))
* add UE4SS runtime payload files and README ([3dc5a96](https://github.com/veryCrunchy/kovaaks/commit/3dc5a963bf65c7e0fa7ecf2eb5b4a0a1730cf690))
* add UE4SS_GITHUB_TOKEN support for GitHub Actions and update README ([4c8079c](https://github.com/veryCrunchy/kovaaks/commit/4c8079c0ad5557144183415f9a0535fd8c565ca5))
* **command:** add command polling and processing functionality ([6809b4f](https://github.com/veryCrunchy/kovaaks/commit/6809b4fa47f1a9d502aab6fbbae3369a994a5870))
* **command:** implement command polling and connection handling ([9d6a37c](https://github.com/veryCrunchy/kovaaks/commit/9d6a37cae75b01e43f902a878fc9a4330e65d9fd))
* **debug:** add bridge state overlay HUD toggles ([7eff530](https://github.com/veryCrunchy/kovaaks/commit/7eff5301f24d4b88b6f451ab0da443c45c660445))
* Enhance analytics with new session record structures and calculations ([c8ec775](https://github.com/veryCrunchy/kovaaks/commit/c8ec7756218997f685d3827281bbe7672a15b06b))
* Enhance bridge command handling and state synchronization ([f2b5730](https://github.com/veryCrunchy/kovaaks/commit/f2b5730dc5a4ec6c94f84c4079b51efb371735a5))
* enhance dev workflow with staging and verification of AimMod runtime payload ([1b9fefa](https://github.com/veryCrunchy/kovaaks/commit/1b9fefae0ea4cf590e790f8b9fd10cb1ea148cc0))
* Enhance Discord RPC presence with additional stats and improved formatting ([182a87a](https://github.com/veryCrunchy/kovaaks/commit/182a87a7e3263cfa0db5fd03a11dc4b53546a348))
* Enhance DraggableHUD with collision resolution and size management ([9b7b8a2](https://github.com/veryCrunchy/kovaaks/commit/9b7b8a2eb32419301e2e60b22debec038c1cb90b))
* Enhance DraggableHUD with grid snapping and preset positioning ([78083d3](https://github.com/veryCrunchy/kovaaks/commit/78083d36a677952bb019477d9f52f7e34ad7964a))
* enhance in-game overlay functionality and improve URL handling ([bef26a5](https://github.com/veryCrunchy/kovaaks/commit/bef26a56f99c83cf081b79b6f26759dfa0f5d7c3))
* Enhance live metric handling and state receiver logic ([88f90d4](https://github.com/veryCrunchy/kovaaks/commit/88f90d4687ab77c9770bf873adbbce8c42e9747e))
* Enhance live score metrics handling and state management ([23fc092](https://github.com/veryCrunchy/kovaaks/commit/23fc09241dc3fbdfd9a10dacfd14ccb34325bfde))
* Enhance live score metrics with session management and timestamping ([da90e75](https://github.com/veryCrunchy/kovaaks/commit/da90e755b4cbeeb821dd83bccc005fac24b3f576))
* Enhance overlay functionality with cursor detection and HUD interactivity ([41be2fe](https://github.com/veryCrunchy/kovaaks/commit/41be2febf7d6d0f613f1328d0b8ab159395957a4))
* Enhance session handling with replay tracking and sorting in stats panel ([dc94347](https://github.com/veryCrunchy/kovaaks/commit/dc94347ed88e7ab2826039500151cbea64baf377))
* Enhance session history management with pagination and local storage support ([c2b41b5](https://github.com/veryCrunchy/kovaaks/commit/c2b41b5776275bba3ebd51fa2d8ee133f5c0a6d9))
* Enhance tracking candidate logic with sustained damage conditions ([0d6553a](https://github.com/veryCrunchy/kovaaks/commit/0d6553a4ed388e8d9358a38c42df3ebdfe5accd8))
* Implement active game state handling and context checks ([daa14af](https://github.com/veryCrunchy/kovaaks/commit/daa14af6d444c0f1aa871d1cce67075d43d06f90))
* Implement non-blocking named pipe handling and improve connection management ([9820b18](https://github.com/veryCrunchy/kovaaks/commit/9820b18136cf401276318b72c3a4ae02d1fe69e0))
* Implement replay system with state management and sampling ([60d2a75](https://github.com/veryCrunchy/kovaaks/commit/60d2a759533b2acf467520d5116a64566341ab73))
* Implement shot telemetry event queuing and flushing mechanism ([ceef9ea](https://github.com/veryCrunchy/kovaaks/commit/ceef9ea507d4d8c06bd9f9eced2a93cf05870e06))
* Implement stats panel snapshot capture in file watcher ([8304272](https://github.com/veryCrunchy/kovaaks/commit/8304272836e76b09286deca8af59bd99f251addc))
* Integrate SQLite for session and replay asset management ([ce09a74](https://github.com/veryCrunchy/kovaaks/commit/ce09a7430510cbb29e557f253b5106ca707c03c1))
* **kmod:** add UE4SS bridge mod sources and production diagnostics ([b4c6248](https://github.com/veryCrunchy/kovaaks/commit/b4c6248d47ad780da88ef885c5430754f3a73c82))
* Migrate replay data to typed SQLite tables and enhance session snapshot handling ([41336dc](https://github.com/veryCrunchy/kovaaks/commit/41336dcad42b7462a25657b94e3c82e65abc13f9))
* **overlay:** add live run snapshot and scenario-aware VS mode ([ec7d354](https://github.com/veryCrunchy/kovaaks/commit/ec7d35458c304e0aaf8c4e971e980d597c215d8c))
* **performance:** enhance performance metrics calculation and display ([45635c8](https://github.com/veryCrunchy/kovaaks/commit/45635c80628861413fb8f8fe1d32f7f4396b4d7c))
* Refactor replay data handling to use ReplayPayloadData interface ([fd33486](https://github.com/veryCrunchy/kovaaks/commit/fd33486c19c77c228182117519c62acc2224a4c6))
* **release:** compute and use prerelease tags for dev and prod builds ([f58d5ef](https://github.com/veryCrunchy/kovaaks/commit/f58d5efd6b1b00605d627163ad6513771d0f74db))
* remove OCR pipeline and rebrand app as AimMod ([8d9fa74](https://github.com/veryCrunchy/kovaaks/commit/8d9fa74b5a57c21d639e13d545df1ecdbfcfe6fc))
* Replace session history retrieval with personal best score fetching ([0cb6cd4](https://github.com/veryCrunchy/kovaaks/commit/0cb6cd479d9ad1fa12e7bff74f0d0e116a72116a))
* **replay:** add in-game replay control commands ([7bd363a](https://github.com/veryCrunchy/kovaaks/commit/7bd363ac53f13b6503df48008425048aabea97dd))
* **replay:** add in-game replay controls and status indicators ([e851b64](https://github.com/veryCrunchy/kovaaks/commit/e851b64a64afd0520b291b6e45d4e93a48027f13))
* **state-sync:** implement state request handling and snapshot emission ([5e63d9a](https://github.com/veryCrunchy/kovaaks/commit/5e63d9aaa092d8dc82e000085e4f6657a2b7e3fb))
* **tauri:** stabilize bridge session lifecycle and replay capture ([16b0eff](https://github.com/veryCrunchy/kovaaks/commit/16b0eff097a15528b31e161ef7c9e966a6e38777))
* Update build process to use new frontend build script ([c29dd5b](https://github.com/veryCrunchy/kovaaks/commit/c29dd5bed4190523e5dad6497d813a9b09dabdba))
* Update database schema and add session run summary and timeline support ([5507b8c](https://github.com/veryCrunchy/kovaaks/commit/5507b8cd1b1a8ec7114c5927bb5ff765c1955b40))
* Update icon assets and add new sizes for improved display ([aceb1b4](https://github.com/veryCrunchy/kovaaks/commit/aceb1b4351abcff04f1c9fcbd83322490cdc49af))
* Update session history retrieval to use recent scenarios with deduplication ([5c7adaf](https://github.com/veryCrunchy/kovaaks/commit/5c7adafb4b8de9b387d67216c5f3d5785b8e0431))


### Bug Fixes

* add step to ensure Tauri resource path exists in CI workflow ([ec49d08](https://github.com/veryCrunchy/kovaaks/commit/ec49d08b55091bab1ef946a77d505435c29b080c))
* Adjust injection process age and ensure foreground window focus ([defeb18](https://github.com/veryCrunchy/kovaaks/commit/defeb18dfb429f18327ddeb4e540235343ab5a5c))
* **bridge:** improve state and score sync resilience ([cea6728](https://github.com/veryCrunchy/kovaaks/commit/cea6728c151ca50c378c778e57af632565a20b7e))
* Correct path for beforeBuildCommand in tauri configuration ([5e25897](https://github.com/veryCrunchy/kovaaks/commit/5e258979f0a7923c51ecc95028e2135d087b087a))
* Improve error handling for UE4SS injection and runtime deployment ([f3a68e6](https://github.com/veryCrunchy/kovaaks/commit/f3a68e6a9dfd5499731265a3ed58a798124cf7fd))
* Improve replay context handling with fallback mechanisms ([42098b2](https://github.com/veryCrunchy/kovaaks/commit/42098b27f6302116b0dd71860e6ef7d6f028458f))
* improve robocopy error handling and reset exit code for CI ([6417d4d](https://github.com/veryCrunchy/kovaaks/commit/6417d4dbf3167cba8abf1b2914168e6f8c7f060a))
* Prevent event propagation on dismiss button click ([447381d](https://github.com/veryCrunchy/kovaaks/commit/447381dea989eec4f4e271bc8a1999bb9c1f1330))
* redirect output of template submodule initialization to stderr ([c1039cb](https://github.com/veryCrunchy/kovaaks/commit/c1039cba047351594c0a993dd8a9c970429df437))
* Remove duplicate import of JetBrains Mono font ([65e7d4f](https://github.com/veryCrunchy/kovaaks/commit/65e7d4f9b99aacc2ea392d8062f24407a9bdcf26))
* Simplify beforeBuildCommand to directly reference build script ([1ff3a63](https://github.com/veryCrunchy/kovaaks/commit/1ff3a636b5e8c9969fc51ec0cd87067fe07cb79c))
* simplify Rust check command and update AimMod staging steps ([b32e4e1](https://github.com/veryCrunchy/kovaaks/commit/b32e4e19a8f60f3c86d5e4a46d12cae2e51548ce))
* Update beforeBuildCommand to dynamically locate build script ([91ee22e](https://github.com/veryCrunchy/kovaaks/commit/91ee22e8bc8ba9b78fa9eb2f8b8ae134e27ab36c))
* Update updater JSON upload flag in dev workflow ([c513e3f](https://github.com/veryCrunchy/kovaaks/commit/c513e3fce5dba047cad16c8496fc2d279dd96ae6))

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
