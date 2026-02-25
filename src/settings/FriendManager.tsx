import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types/settings";
import type { FriendProfile, MostPlayedEntry } from "../types/friends";

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
        style={{ background: "rgba(0,245,160,0.12)", color: "#00f5a0" }}
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
      style={{ border: "1px solid rgba(255,255,255,0.1)" }}
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
      <p className="text-xs mt-2 ml-1" style={{ color: "rgba(255,255,255,0.25)" }}>
        Loading scenarios…
      </p>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <p className="text-xs mt-2 ml-1" style={{ color: "rgba(255,255,255,0.2)" }}>
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
            style={{ color: "rgba(255,255,255,0.45)", maxWidth: 200 }}
            title={e.scenario_name}
          >
            {e.scenario_name}
          </span>
          <span className="text-xs tabular-nums flex-shrink-0" style={{ color: "rgba(255,255,255,0.3)" }}>
            {e.counts.plays} plays · {Math.round(e.score).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FriendManager({ settings, onChange }: FriendManagerProps) {
  const [friends, setFriends] = useState<FriendProfile[]>(settings.friends ?? []);
  const [selectedOpponent, setSelectedOpponent] = useState<string | null>(settings.selected_friend ?? null);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const handleAdd = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      // add_friend validates against KovaaK's API and returns the full profile
      const profile = await invoke<FriendProfile>("add_friend", { username: trimmed });
      const next = await invoke<FriendProfile[]>("get_friends");
      updateFriends(next);
      setInput("");
      showSuccess(`Added ${profile.steam_account_name || profile.username}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }, [input, updateFriends]);

  const handleRemove = useCallback(
    async (username: string) => {
      try {
        await invoke("remove_friend", { username });
        updateFriends(friends.filter((f) => f.username !== username));
        showSuccess(`Removed ${username}`);
        if (expanded === username) setExpanded(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [friends, updateFriends, expanded]
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

  return (
    <div className="p-8 max-w-2xl" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <h1
        className="text-lg font-bold mb-2 tracking-wider"
        style={{ color: "rgba(255,255,255,0.9)" }}
      >
        Friends
      </h1>
      <p className="text-xs mb-8" style={{ color: "rgba(255,255,255,0.35)" }}>
        Add friends by their KovaaK's webapp username. Their best scores are fetched
        automatically from the KovaaK's API when you start a scenario.
      </p>

      {/* Add input */}
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          placeholder="KovaaK's username"
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={handleKeyDown}
          disabled={adding}
          className="flex-1 rounded-lg px-3 py-2 text-sm"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#fff",
            outline: "none",
            opacity: adding ? 0.6 : 1,
          }}
        />
        <button
          onClick={handleAdd}
          disabled={adding || !input.trim()}
          className="px-4 py-2 rounded-lg text-sm font-semibold"
          style={{
            background: input.trim() ? "#00f5a0" : "rgba(0,245,160,0.15)",
            color: input.trim() ? "#000" : "rgba(0,245,160,0.35)",
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
            background: "rgba(255,77,77,0.1)",
            border: "1px solid rgba(255,77,77,0.3)",
            color: "#ff6b6b",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mb-4 px-4 py-3 rounded-lg text-sm"
          style={{
            background: "rgba(0,245,160,0.08)",
            border: "1px solid rgba(0,245,160,0.25)",
            color: "#00f5a0",
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
            border: "1px dashed rgba(255,255,255,0.1)",
            color: "rgba(255,255,255,0.3)",
          }}
        >
          No friends added yet. Enter a KovaaK's username above.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {friends.map((f) => (
            <div
              key={f.username}
              className="rounded-xl overflow-hidden"
              style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
              }}
            >
              {/* Main row */}
              <div className="flex items-center justify-between px-4 py-3 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar url={f.avatar_url} name={f.steam_account_name || f.username} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold truncate" style={{ color: "#fff" }}>
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
                          style={{ background: "rgba(255,180,0,0.15)", color: "#ffb400" }}
                        >
                          K+
                        </span>
                      )}
                    </div>
                    {f.steam_account_name && f.steam_account_name !== f.username && (
                      <span className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
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
                        ? "rgba(255,107,107,0.18)"
                        : "rgba(255,255,255,0.04)",
                      border: selectedOpponent === f.username
                        ? "1px solid rgba(255,107,107,0.45)"
                        : "1px solid rgba(255,255,255,0.1)",
                      color: selectedOpponent === f.username ? "#ff6b6b" : "rgba(255,255,255,0.35)",
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
                      border: "1px solid rgba(255,255,255,0.1)",
                      color: "rgba(255,255,255,0.4)",
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
                      background: "rgba(0,180,255,0.06)",
                      border: "1px solid rgba(0,180,255,0.15)",
                      color: "rgba(0,180,255,0.6)",
                      textDecoration: "none",
                    }}
                  >
                    ↗
                  </a>
                  <button
                    onClick={() => handleRemove(f.username)}
                    className="px-3 py-1 rounded-lg text-xs"
                    style={{
                      background: "rgba(255,77,77,0.08)",
                      border: "1px solid rgba(255,77,77,0.2)",
                      color: "#ff6b6b",
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
                  style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
                >
                  <p
                    className="text-xs mt-2 mb-1 uppercase tracking-widest"
                    style={{ color: "rgba(255,255,255,0.2)" }}
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

      <p className="text-xs mt-6" style={{ color: "rgba(255,255,255,0.2)" }}>
        Scores are fetched live from kovaaks.com — no files to export or share.
      </p>
    </div>
  );
}

