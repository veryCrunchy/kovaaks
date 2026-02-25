/**
 * @deprecated Import from the specific type files instead:
 *   settings types  → `./settings`
 *   friend types    → `./friends`
 *   mouse metrics   → `./mouse`
 *   overlay/OCR     → `./overlay`
 * This barrel exists for backward compatibility only.
 */
export type { RegionRect, StatsFieldRegions, AppSettings, MonitorInfo } from "./settings";
export type { FriendProfile, MostPlayedEntry, FriendScore } from "./friends";
export type { MouseMetrics, MetricPoint, RawPositionPoint, ScreenFrame } from "./mouse";
export type { LiveScorePayload, SessionResult, StatsPanelReading, ShotEvent, LiveFeedback } from "./overlay";

