import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { C } from "../design/tokens";
import type { AppSettings } from "../types/settings";
import type { FriendProfile, MostPlayedEntry } from "../types/friends";

interface LiveFriendScoreEntry {
  steam_id: string;
  steam_account_name: string;
  score: number;
  rank: number;
  kovaaks_plus_active: boolean;
}

interface LiveFriendScoresSnapshot {
  source: string;
  scenario_name: string;
  leaderboard_id: number;
  response_code: number;
  entries: LiveFriendScoreEntry[];
}

interface FriendManagerProps {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
}

/** Convert a 2-letter ISO country code to a flag emoji. */
function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  const codePoints = [...code.toUpperCase()].map(
    (c) => 0x1f1e6 + c.charCodeAt(0) - 65
  );
  return String.fromCodePoint(...codePoints);
}

function Avatar({ url, name }: { url: string; name: string }) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return (
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
        style={{ background: C.accentDim, color: C.accent }}
      >
        {name.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={name}
      onError={() => setErr(true)}
      className="w-10 h-10 rounded-full object-cover shrink-0"
      style={{ border: `1px solid ${C.border}` }}
    />
  );
}

function MostPlayedRow({ username }: { username: string }) {
  const [entries, setEntries] = useState<MostPlayedEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    invoke<MostPlayedEntry[]>("fetch_friend_most_played", { username })
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [username]);

  if (loading) {
    return (
      <p className="text-xs mt-2 ml-1" style={{ color: C.textMuted }}>
        Loading scenarios…
      </p>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <p className="text-xs mt-2 ml-1" style={{ color: C.textFaint }}>
        No scenarios found.
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-1">
      {entries.slice(0, 5).map((e) => (
        <div key={e.scenario_name} className="flex items-center justify-between gap-2">
          <span
            className="text-xs truncate"
            style={{ color: C.textMuted, maxWidth: 200 }}
            title={e.scenario_name}
          >
            {e.scenario_name}
          </span>
          <span className="text-xs tabular-nums shrink-0" style={{ color: C.textFaint }}>
            {e.counts.plays} plays · {Math.round(e.score).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

type SearchType = "auto" | "kovaaks" | "steam";

const SEARCH_TYPES: { label: string; value: SearchType; placeholder: string }[] = [
  { label: "Auto",      value: "auto",    placeholder: "KovaaK's username or Steam ID" },
  { label: "KovaaK's", value: "kovaaks", placeholder: "KovaaK's webapp username" },
  { label: "Steam",    value: "steam",   placeholder: "Steam ID, vanity URL, or steamcommunity.com link" },
];

function looksLikeSteamId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 17 && /^\d+$/.test(trimmed);
}

export function FriendManager({ settings, onChange }: FriendManagerProps) {
  const [friends, setFriends] = useState<FriendProfile[]>(settings.friends ?? []);
  const [liveScores, setLiveScores] = useState<LiveFriendScoresSnapshot | null>(null);
  const [selectedOpponent, setSelectedOpponent] = useState<string | null>(settings.selected_friend ?? null);
  const [input, setInput] = useState("");
  const [searchType, setSearchType] = useState<SearchType>("auto");
  const [adding, setAdding] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refreshFriends = useCallback(async () => {
    try {
      const next = await invoke<FriendProfile[]>("get_friends");
      setFriends(next);
      onChange({
        ...settings,
        friends: next.filter((friend) => !friend.bridge_managed),
      });
    } catch (e) {
      setError(String(e));
    }
  }, [onChange, settings]);

  const refreshLiveScores = useCallback(async () => {
    try {
      const snapshot = await invoke<LiveFriendScoresSnapshot | null>("get_live_friend_scores");
      setLiveScores(snapshot);
    } catch {
      setLiveScores(null);
    }
  }, []);

  const showSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  useEffect(() => {
    void refreshFriends();
    void refreshLiveScores();
    const unlistenPromise = listen("kovaaks-friends-updated", () => {
      void refreshFriends();
      void refreshLiveScores();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [refreshFriends, refreshLiveScores]);

  useEffect(() => {
    setSelectedOpponent(settings.selected_friend ?? null);
  }, [settings.selected_friend]);

  const handleAdd = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      const profile = await invoke<FriendProfile>("add_friend", {
        username: trimmed,
        searchType: searchType === "auto" ? null : searchType,
      });
      await refreshFriends();
      setInput("");
      showSuccess(`Added ${profile.steam_account_name || profile.username}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }, [input, refreshFriends, searchType]);

  const handleRemove = useCallback(
    async (username: string) => {
      const friend = friends.find((entry) => entry.username === username);
      if (!friend || friend.bridge_managed) return;

      setError(null);
      try {
        await invoke("remove_friend", { username: friend.username });
        if (selectedOpponent === username) {
          await invoke("set_selected_friend", { username: null });
          onChange({ ...settings, selected_friend: null });
        }
        setSelectedOpponent(null);
        await refreshFriends();
        if (expanded === username) {
          setExpanded(null);
        }
        showSuccess(`Removed ${friend.steam_account_name || friend.username}`);
      } catch (e) {
        setError(String(e));
      }
    },
    [expanded, friends, onChange, refreshFriends, selectedOpponent, settings]
  );

  const handleSetOpponent = useCallback(
    async (username: string) => {
      const next = selectedOpponent === username ? null : username;
      try {
        await invoke("set_selected_friend", { username: next });
        setSelectedOpponent(next);
        onChange({ ...settings, selected_friend: next });
        showSuccess(next ? `${next} set as battle opponent` : "Opponent cleared");
      } catch (e) {
        setError(String(e));
      }
    },
    [selectedOpponent, settings, onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleAdd();
  };

  const toggleExpand = (username: string) => {
    setExpanded((prev) => (prev === username ? null : username));
  };

  const getLiveScore = (friend: FriendProfile): LiveFriendScoreEntry | null => {
    if (!liveScores) return null;
    return (
      liveScores.entries.find((entry) =>
        friend.steam_id
          ? entry.steam_id === friend.steam_id
          : entry.steam_account_name.toLowerCase() === (friend.steam_account_name || friend.username).toLowerCase()
      ) ?? null
    );
  };

  return (
    <div className="p-8 max-w-2xl" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <h1
        className="text-lg font-bold mb-2 tracking-wider"
        style={{ color: C.text }}
      >
        Friends
      </h1>
      <p className="text-xs mb-6" style={{ color: C.textFaint }}>
        Live friends come from the AimMod bridge and update automatically while KovaaK's is running.
        Use manual add only for extra people you want to track outside the live bridge list.
      </p>

      {/* Search type toggle */}
      <div className="flex gap-1 mb-3">
        {SEARCH_TYPES.map((t) => (
          <button
            key={t.value}
            onClick={() => setSearchType(t.value)}
            className="am-btn px-3 py-1 rounded text-xs"
            style={{
              background: searchType === t.value ? C.accentDim : "rgba(255,255,255,0.04)",
              border: `1px solid ${searchType === t.value ? C.accentBorder : C.borderSub}`,
              color: searchType === t.value ? C.accent : C.textFaint,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Add input */}
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          placeholder={SEARCH_TYPES.find((t) => t.value === searchType)?.placeholder ?? ""}
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={handleKeyDown}
          disabled={adding}
          className="am-input flex-1 rounded-lg px-3 py-2 text-sm"
          style={{ opacity: adding ? 0.6 : 1 }}
        />
        <button
          onClick={handleAdd}
          disabled={adding || !input.trim()}
          className="am-btn px-4 py-2 rounded-lg text-sm font-semibold"
          style={{
            background: input.trim() ? C.accent : C.accentDim,
            color: input.trim() ? "#000" : C.textFaint,
            cursor: adding || !input.trim() ? "not-allowed" : "pointer",
            border: "none",
            minWidth: 80,
            opacity: adding ? 0.7 : 1,
          }}
        >
          {adding ? "Checking…" : "Add"}
        </button>
      </div>

      {/* Status messages */}
      {error && (
        <div
          className="mb-4 px-4 py-3 rounded-lg text-sm"
          style={{
            background: `${C.danger}1a`,
            border: `1px solid ${C.dangerBorder}`,
            color: C.danger,
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mb-4 px-4 py-3 rounded-lg text-sm"
          style={{
            background: C.accentDim,
            border: `1px solid ${C.accentBorder}`,
            color: C.accent,
          }}
        >
          {success}
        </div>
      )}

      {/* Friend list */}
      {friends.length === 0 ? (
        <div
          className="rounded-xl p-8 text-center text-sm"
          style={{
            border: `1px dashed ${C.border}`,
            color: C.textFaint,
          }}
        >
          No friends yet. Start KovaaK's with the mod bridge active, or add someone manually below.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {friends.map((f) => (
            <div
              key={f.username}
              className="rounded-xl overflow-hidden"
              style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
              }}
            >
              {/* Main row */}
              <div className="flex items-center justify-between px-4 py-3 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar url={f.avatar_url} name={f.steam_account_name || f.username} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold truncate" style={{ color: C.text }}>
                        {f.steam_account_name || f.username}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider"
                        style={{
                          background: f.bridge_managed ? `${C.info}18` : `${C.accent}18`,
                          color: f.bridge_managed ? C.info : C.accent,
                        }}
                      >
                        {f.bridge_managed ? "Live" : "Manual"}
                      </span>
                      {f.country && (
                        <span className="text-base leading-none" title={f.country.toUpperCase()}>
                          {countryFlag(f.country)}
                        </span>
                      )}
                      {f.kovaaks_plus && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-bold"
                          style={{ background: `${C.warn}25`, color: C.warn }}
                        >
                          K+
                        </span>
                      )}
                    </div>
                    {f.steam_account_name && f.steam_account_name !== f.username && (
                      <span className="text-xs" style={{ color: C.textFaint }}>
                        @{f.username}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleSetOpponent(f.username)}
                    className="px-2 py-1.5 rounded text-xs font-semibold"
                    style={{
                      background: selectedOpponent === f.username
                        ? `${C.danger}2e`
                        : "rgba(255,255,255,0.04)",
                      border: `1px solid ${selectedOpponent === f.username ? C.dangerBorder : C.borderSub}`,
                      color: selectedOpponent === f.username ? C.danger : C.textFaint,
                      cursor: "pointer",
                    }}
                    title={selectedOpponent === f.username ? "Remove as opponent" : "Set as battle opponent"}
                  >
                    {selectedOpponent === f.username ? "Active" : "VS"}
                  </button>
                  <button
                    onClick={() => toggleExpand(f.username)}
                    className="px-2 py-1 rounded text-xs"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: `1px solid ${C.borderSub}`,
                      color: C.textMuted,
                      cursor: "pointer",
                    }}
                    title="Show most-played scenarios"
                  >
                    {expanded === f.username ? "▲" : "▼"}
                  </button>
                  {!looksLikeSteamId(f.username) && (
                    <a
                      href={`https://kovaaks.com/kovaaks/profile?username=${f.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2 py-1 rounded text-xs"
                      style={{
                        background: `${C.info}0f`,
                        border: `1px solid ${C.info}26`,
                        color: `${C.info}99`,
                        textDecoration: "none",
                      }}
                    >
                      ↗
                    </a>
                  )}
                  {!f.bridge_managed && (
                    <button
                      onClick={() => handleRemove(f.username)}
                      className="px-3 py-1 rounded-lg text-xs"
                      style={{
                        background: `${C.danger}14`,
                        border: `1px solid ${C.dangerBorder}`,
                        color: C.danger,
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {/* Expandable details */}
              {expanded === f.username && (
                <div
                  className="px-4 pb-3"
                  style={{ borderTop: `1px solid ${C.borderSub}` }}
                >
                  {f.bridge_managed ? (
                    <>
                      <p
                        className="text-xs mt-2 mb-1 uppercase tracking-widest"
                        style={{ color: C.textFaint }}
                      >
                        Live in-game score
                      </p>
                      {getLiveScore(f) ? (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span
                            className="text-xs truncate"
                            style={{ color: C.textMuted, maxWidth: 220 }}
                            title={liveScores?.scenario_name ?? ""}
                          >
                            {liveScores?.scenario_name || "Current scenario"}
                          </span>
                          <span className="text-xs tabular-nums shrink-0" style={{ color: C.text }}>
                            #{getLiveScore(f)!.rank.toLocaleString()} · {Math.round(getLiveScore(f)!.score).toLocaleString()}
                          </span>
                        </div>
                      ) : (
                        <p className="text-xs mt-2 ml-1" style={{ color: C.textFaint }}>
                          Waiting for current in-game leaderboard data…
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p
                        className="text-xs mt-2 mb-1 uppercase tracking-widest"
                        style={{ color: C.textFaint }}
                      >
                        Most played
                      </p>
                      <MostPlayedRow username={f.username} />
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs mt-6" style={{ color: C.textFaint }}>
        Live bridge friends use in-game leaderboard data. Manual friends still use web lookups for profile history. Live bridge friends cannot be removed here because the game is the source of truth for that list.
      </p>
    </div>
  );
}
