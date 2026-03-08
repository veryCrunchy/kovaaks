/**
 * @deprecated Import from the specific type files instead:
 *   settings types  → `./settings`
 *   friend types    → `./friends`
 *   mouse metrics   → `./mouse`
 *   overlay types   → `./overlay`
 * This barrel exists for backward compatibility only.
 */
export type { RegionRect, AppSettings, MonitorInfo } from "./settings";
export type { FriendProfile, MostPlayedEntry, FriendScore } from "./friends";
export type {
	MouseMetrics,
	MetricPoint,
	RawPositionPoint,
	ScreenFrame,
	ReplayPayloadData,
	BridgeShotTelemetryEntity,
	BridgeShotTelemetryTarget,
	BridgeShotTelemetryEvent,
} from "./mouse";
export type { SessionResult, StatsPanelReading, ShotEvent, LiveFeedback } from "./overlay";
