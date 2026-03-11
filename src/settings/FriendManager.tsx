import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { C } from "../design/tokens";
import type { AppSettings } from "../types/settings";
import type { ActiveSteamUser, FriendProfile, MostPlayedEntry } from "../types/friends";

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
        className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
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
      className="w-10 h-10 rounded-full object-cover flex-shrink-0"
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
          <span className="text-xs tabular-nums flex-shrink-0" style={{ color: C.textFaint }}>
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

export function FriendManager({ settings, onChange }: FriendManagerProps) {
  const [friends, setFriends] = useState<FriendProfile[]>(settings.friends ?? []);
  const [selectedOpponent, setSelectedOpponent] = useState<string | null>(settings.selected_friend ?? null);
  const [input, setInput] = useState("");
  const [searchType, setSearchType] = useState<SearchType>("auto");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [steamUser, setSteamUser] = useState<ActiveSteamUser | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{ friend: FriendProfile; wasSelected: boolean } | null>(null);
  const pendingRemovalTimerRef = useRef<number | null>(null);

  // Detect the active Steam user on mount so we can show the import button.
  useEffect(() => {
    invoke<ActiveSteamUser | null>("get_active_steam_user")
      .then(setSteamUser)
      .catch(() => setSteamUser(null));
  }, []);

  const updateFriends = useCallback(
    (next: FriendProfile[]) => {
      setFriends(next);
      onChange({ ...settings, friends: next });
    },
    [settings, onChange]
  );

  const showSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  };

  const clearPendingRemovalTimer = useCallback(() => {
    if (pendingRemovalTimerRef.current != null) {
      window.clearTimeout(pendingRemovalTimerRef.current);
      pendingRemovalTimerRef.current = null;
    }
  }, []);

  const commitPendingRemoval = useCallback(async (entry: { friend: FriendProfile; wasSelected: boolean }) => {
    clearPendingRemovalTimer();
    setPendingRemoval(null);
    try {
      const friend = entry.friend;
      await invoke("remove_friend", { username: friend.username });
      if (entry.wasSelected || selectedOpponent === friend.username) {
        await invoke("set_selected_friend", { username: null });
        setSelectedOpponent(null);
        onChange({ ...settings, selected_friend: null, friends: friends.filter((f) => f.username !== friend.username) });
      }
      showSuccess(`Removed ${friend.steam_account_name || friend.username}`);
    } catch (e) {
      setError(String(e));
    }
  }, [clearPendingRemovalTimer, friends, onChange, selectedOpponent, settings]);

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
      const next = await invoke<FriendProfile[]>("get_friends");
      updateFriends(next);
      setInput("");
      showSuccess(`Added ${profile.steam_account_name || profile.username}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }, [input, searchType, updateFriends]);

  const handleRemove = useCallback(
    async (username: string) => {
      const friend = friends.find((entry) => entry.username === username);
      if (!friend) return;

      if (pendingRemoval && pendingRemoval.friend.username !== username) {
        await commitPendingRemoval(pendingRemoval);
      }

      clearPendingRemovalTimer();
      setPendingRemoval({ friend, wasSelected: selectedOpponent === username });
      updateFriends(friends.filter((f) => f.username !== username));
      if (selectedOpponent === username) {
        setSelectedOpponent(null);
        onChange({ ...settings, selected_friend: null, friends: friends.filter((f) => f.username !== username) });
      }
      if (expanded === username) setExpanded(null);
      setError(null);
      setSuccess(null);
      pendingRemovalTimerRef.current = window.setTimeout(() => {
        void commitPendingRemoval({ friend, wasSelected: selectedOpponent === username });
      }, 5000);
    },
    [clearPendingRemovalTimer, commitPendingRemoval, expanded, friends, onChange, pendingRemoval, selectedOpponent, settings, updateFriends]
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

  const handleImportSteam = useCallback(async () => {
    setImporting(true);
    setImportProgress(0);
    setError(null);
    // Subscribe to per-friend progress events before invoking.
    unlistenRef.current = await listen("steam-import-progress", () => {
      setImportProgress((n) => n + 1);
    });
    try {
      const added = await invoke<FriendProfile[]>("import_steam_friends");
      if (added.length === 0) {
        showSuccess("All detected KovaaK's friends are already added (or the list is empty).");
      } else {
        const next = await invoke<FriendProfile[]>("get_friends");
        updateFriends(next);
        showSuccess(`Imported ${added.length} KovaaK's friend${added.length === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setImporting(false);
      setImportProgress(0);
    }
  }, [updateFriends]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleAdd();
  };

  const toggleExpand = (username: string) => {
    setExpanded((prev) => (prev === username ? null : username));
  };

  const handleUndoRemove = useCallback(() => {
    if (!pendingRemoval) return;
    clearPendingRemovalTimer();
    const nextFriends = [...friends, pendingRemoval.friend]
      .sort((a, b) => (a.steam_account_name || a.username).localeCompare(b.steam_account_name || b.username));
    updateFriends(nextFriends);
    setPendingRemoval(null);
    if (pendingRemoval.wasSelected) {
      setSelectedOpponent(pendingRemoval.friend.username);
      onChange({ ...settings, selected_friend: pendingRemoval.friend.username, friends: nextFriends });
    }
    showSuccess(`Kept ${pendingRemoval.friend.steam_account_name || pendingRemoval.friend.username}`);
  }, [clearPendingRemovalTimer, friends, onChange, pendingRemoval, settings, updateFriends]);

  useEffect(() => () => clearPendingRemovalTimer(), [clearPendingRemovalTimer]);

  return (
    <div className="p-8 max-w-2xl" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <h1
        className="text-lg font-bold mb-2 tracking-wider"
        style={{ color: C.text }}
      >
        Friends
      </h1>
      <p className="text-xs mb-6" style={{ color: C.textFaint }}>
        Add friends by KovaaK's username, Steam64 ID, vanity URL, or steamcommunity.com link.
        Friends with a linked KovaaK's account support VS-mode score comparison.
      </p>

      {/* Steam import banner */}
      {steamUser && (
        <div
          className="flex items-center justify-between gap-3 mb-5 px-4 py-3 rounded-xl"
          style={{
            background: `${C.info}0f`,
            border: `1px solid ${C.info}30`,
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            {steamUser.avatar_url ? (
              <img
                src={steamUser.avatar_url}
                alt={steamUser.display_name}
                className="w-8 h-8 rounded-full flex-shrink-0"
                style={{ border: `1px solid ${C.info}50` }}
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                style={{ background: `${C.info}25`, color: C.info }}
              >
                {steamUser.display_name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate" style={{ color: C.text }}>
                {steamUser.display_name}
              </div>
              <div className="text-xs" style={{ color: `${C.info}b0` }}>
                Steam detected
              </div>
            </div>
          </div>
          <button
            onClick={handleImportSteam}
            disabled={importing}
            className="am-btn px-3 py-1.5 rounded-lg text-xs font-semibold flex-shrink-0"
            style={{
              background: importing ? `${C.info}14` : `${C.info}25`,
              border: `1px solid ${C.info}59`,
              color: importing ? `${C.info}66` : C.info,
              cursor: importing ? "not-allowed" : "pointer",
            }}
          >
            {importing ? `Importing… ${importProgress > 0 ? importProgress : ""}` : "Import KovaaK's Friends"}
          </button>
        </div>
      )}

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
            color: input.trim() ? "#000" : `${C.accent}59`,
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
      {pendingRemoval && (
        <div
          className="mb-4 px-4 py-3 rounded-lg text-sm flex items-center justify-between gap-3"
          style={{
            background: `${C.warn}14`,
            border: `1px solid ${C.warn}40`,
            color: C.textSub,
          }}
        >
          <span>
            {pendingRemoval.friend.steam_account_name || pendingRemoval.friend.username} will be removed in a few seconds.
          </span>
          <button
            type="button"
            onClick={handleUndoRemove}
            className="px-3 py-1 rounded-lg text-xs font-semibold"
            style={{
              background: `${C.warn}24`,
              border: `1px solid ${C.warn}55`,
              color: C.warn,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Undo
          </button>
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
          No friends added yet. Enter a KovaaK's username, Steam name, or Steam ID above.
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

                <div className="flex items-center gap-2 flex-shrink-0">
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
                </div>
              </div>

              {/* Expandable most-played */}
              {expanded === f.username && (
                <div
                  className="px-4 pb-3"
                  style={{ borderTop: `1px solid ${C.borderSub}` }}
                >
                  <p
                    className="text-xs mt-2 mb-1 uppercase tracking-widest"
                    style={{ color: C.textFaint }}
                  >
                    Most played
                  </p>
                  <MostPlayedRow username={f.username} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs mt-6" style={{ color: C.textFaint }}>
        Scores are fetched live from kovaaks.com — no files to export or share.
      </p>
    </div>
  );
}
