import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ScenarioSearchResult {
  leaderboard_id: number;
  scenario_name: string;
  aim_type: string | null;
  description: string | null;
  play_count: number;
  entry_count: number;
  top_score: number;
}

interface ScenarioPage {
  total: number;
  page: number;
  data: ScenarioSearchResult[];
}

interface LeaderboardEntry {
  rank: number;
  steam_id: string;
  steam_account_name: string;
  webapp_username: string | null;
  score: number;
  country: string | null;
  kovaaks_plus: boolean;
}

interface LeaderboardPage {
  total: number;
  page: number;
  data: LeaderboardEntry[];
}

interface ScenarioDetails {
  scenario_name: string;
  aim_type: string | null;
  play_count: number;
  description: string | null;
  tags: string[];
  created: string | null;
  author_steam_account_name: string | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const SCENARIO_PAGE = 20;

const BG = "#0a0a0f";
const BORDER = "rgba(255,255,255,0.07)";
const ACCENT = "#00f5a0";
const MUTED = "rgba(255,255,255,0.3)";
const MUTED2 = "rgba(255,255,255,0.45)";
const DIVIDER = "rgba(255,255,255,0.06)";
const CARD_BG = "rgba(255,255,255,0.04)";
const SIDEBAR_BG = "rgba(255,255,255,0.015)";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function fmtScore(n: number) {
  return Number.isInteger(n) || n > 999 ? Math.round(n).toLocaleString() : n.toFixed(2);
}

function fmtDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function CountryFlag({ cc }: { cc: string }) {
  const code = cc.toUpperCase();
  return (
    <img
      src={`https://storage.googleapis.com/kovaaks_public/country_flags/${code}.svg`}
      alt={code}
      title={code}
      style={{ width: 18, height: 12, objectFit: "cover", borderRadius: 2, flexShrink: 0 }}
      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
    />
  );
}

function RankBadge({ rank }: { rank: number }) {
  const colors: Record<number, string> = { 1: "#FFD700", 2: "#C0C0C0", 3: "#CD7F32" };
  const color = colors[rank] ?? MUTED2;
  return (
    <span style={{ fontWeight: 700, color, minWidth: 36, display: "inline-block", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
      #{rank}
    </span>
  );
}

// ─── Resolve a scenario name to a ScenarioSearchResult ─────────────────────────

async function resolveScenarioByName(name: string): Promise<ScenarioSearchResult | null> {
  try {
    const page = await invoke<ScenarioPage>("search_scenarios", { query: name, page: 0, max: 5 });
    return (
      page.data.find((s) => s.scenario_name.toLowerCase() === name.toLowerCase()) ??
      page.data[0] ??
      null
    );
  } catch {
    return null;
  }
}

// ─── Main component ────────────────────────────────────────────────────────────

export function LeaderboardBrowser() {
  const [query, setQuery] = useState("");
  const [scenarioPage, setScenarioPage] = useState<ScenarioPage | null>(null);
  const [scenarioPageNum, setScenarioPageNum] = useState(0);
  const [scenarioLoading, setScenarioLoading] = useState(false);

  // Recently-played scenarios, pre-fetched from session history
  const [recentScenarios, setRecentScenarios] = useState<ScenarioSearchResult[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);

  const [selected, setSelected] = useState<ScenarioSearchResult | null>(null);
  const [details, setDetails] = useState<ScenarioDetails | null>(null);
  const [lbPage, setLbPage] = useState<LeaderboardPage | null>(null);
  const [lbPageNum, setLbPageNum] = useState(0);
  const [lbLoading, setLbLoading] = useState(false);

  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load recent scenarios from session history ──────────────────────────────

  useEffect(() => {
    invoke<{ scenario: string; timestamp: string }[]>("get_session_history")
      .then((records) => {
        // Sort by timestamp descending, deduplicate on normalised name, cap at 15
        const sorted = [...records].sort((a, b) =>
          b.timestamp > a.timestamp ? 1 : -1
        );
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const r of sorted) {
          // Strip KovaaK's datestamp suffix, same as StatsWindow.normalizeScenario
          const raw = r.scenario;
          const m = raw.match(/\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}/);
          const sep = m && m.index !== undefined ? raw.lastIndexOf(" - ", m.index) : -1;
          const name = sep >= 0 ? raw.slice(0, sep) : raw;
          if (!seen.has(name)) { seen.add(name); unique.push(name); }
          if (unique.length >= 15) break;
        }
        return Promise.all(unique.map(resolveScenarioByName));
      })
      .then((results) => {
        setRecentScenarios(results.filter((r): r is ScenarioSearchResult => r !== null));
      })
      .catch(console.error)
      .finally(() => setRecentLoading(false));
  }, []);

  // ── Scenario search ─────────────────────────────────────────────────────────

  const runSearch = useCallback((q: string, page: number) => {
    setScenarioLoading(true);
    invoke<ScenarioPage>("search_scenarios", { query: q, page, max: SCENARIO_PAGE })
      .then((r) => { setScenarioPage(r); setScenarioPageNum(page); })
      .catch(console.error)
      .finally(() => setScenarioLoading(false));
  }, []);

  // Only fetch the full popular list when user is actively searching
  useEffect(() => {
    if (query) runSearch(query, 0);
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  function handleSearch(value: string) {
    setQuery(value);
    setScenarioPageNum(0);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (value) {
      searchDebounce.current = setTimeout(() => runSearch(value, 0), 300);
    } else {
      setScenarioPage(null);
    }
  }

  // ── Scenario selection ──────────────────────────────────────────────────────

  function selectScenario(s: ScenarioSearchResult) {
    setSelected(s);
    setDetails(null);
    setLbPage(null);
    setLbPageNum(0);

    // Load leaderboard + details in parallel
    setLbLoading(true);
    Promise.all([
      invoke<LeaderboardPage>("get_leaderboard_page", {
        leaderboardId: s.leaderboard_id,
        page: 0,
        max: PAGE_SIZE,
      }),
      invoke<ScenarioDetails>("get_scenario_details", { leaderboardId: s.leaderboard_id }),
    ])
      .then(([lb, det]) => {
        setLbPage(lb);
        setDetails(det);
      })
      .catch(console.error)
      .finally(() => setLbLoading(false));
  }

  // ── Leaderboard pagination ──────────────────────────────────────────────────

  function goLbPage(page: number) {
    if (!selected) return;
    setLbLoading(true);
    invoke<LeaderboardPage>("get_leaderboard_page", {
      leaderboardId: selected.leaderboard_id,
      page,
      max: PAGE_SIZE,
    })
      .then((r) => { setLbPage(r); setLbPageNum(page); })
      .catch(console.error)
      .finally(() => setLbLoading(false));
  }

  const totalLbPages = lbPage ? Math.ceil(lbPage.total / PAGE_SIZE) : 0;
  const totalScenarioPages = scenarioPage ? Math.ceil(scenarioPage.total / SCENARIO_PAGE) : 0;
  const isSearching = query.length > 0;
  const sidebarItems: ScenarioSearchResult[] = isSearching
    ? (scenarioPage?.data ?? [])
    : recentScenarios;

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: BG,
        color: "#fff",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        overflow: "hidden",
      }}
    >
      {/* ── Left panel: scenario list ──────────────────────────────────────── */}
      <div
        style={{
          width: 250,
          minWidth: 250,
          flexShrink: 0,
          borderRight: `1px solid ${BORDER}`,
          display: "flex",
          flexDirection: "column",
          background: SIDEBAR_BG,
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 14px 10px", borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: "#fff", letterSpacing: 0.3 }}>
            Leaderboards
          </div>
          <input
            type="text"
            placeholder="Search scenarios..."
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            style={{
              width: "100%",
              background: "rgba(255,255,255,0.06)",
              border: `1px solid rgba(255,255,255,0.1)`,
              borderRadius: 7,
              padding: "6px 10px",
              color: "#fff",
              fontSize: 12,
              outline: "none",
              boxSizing: "border-box",
              fontFamily: "inherit",
            }}
          />
          {isSearching && scenarioPage && (
            <div style={{ marginTop: 6, color: MUTED, fontSize: 11 }}>
              {fmt(scenarioPage.total)} scenarios
            </div>
          )}
          {!isSearching && (
            <div style={{ marginTop: 6, color: MUTED, fontSize: 11 }}>
              {recentLoading ? "Loading..." : `${recentScenarios.length} recent`}
            </div>
          )}
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          {!isSearching && !recentLoading && recentScenarios.length === 0 && (
            <div style={{ padding: 20, color: MUTED, textAlign: "center", fontSize: 12, lineHeight: 1.6 }}>
              Play some sessions to see your recent scenarios here.
            </div>
          )}
          {!isSearching && recentLoading && (
            <div style={{ padding: 20, color: MUTED, textAlign: "center" }}>Loading...</div>
          )}
          {isSearching && scenarioLoading && !scenarioPage && (
            <div style={{ padding: 20, color: MUTED, textAlign: "center" }}>Loading...</div>
          )}
          {!isSearching && !recentLoading && recentScenarios.length > 0 && (
            <div style={{ padding: "6px 12px 2px", fontSize: 10, color: "rgba(255,255,255,0.25)", textTransform: "uppercase", letterSpacing: 1 }}>
              Recent
            </div>
          )}
          {sidebarItems.map((s) => (
            <ScenarioRow
              key={s.leaderboard_id}
              scenario={s}
              active={selected?.leaderboard_id === s.leaderboard_id}
              onClick={() => selectScenario(s)}
            />
          ))}
          {isSearching && (!scenarioPage || scenarioPage.data.length === 0) && !scenarioLoading && (
            <div style={{ padding: 20, color: MUTED, textAlign: "center" }}>No scenarios found</div>
          )}
        </div>

        {/* Pagination */}
        {totalScenarioPages > 1 && (
          <Pagination
            current={scenarioPageNum}
            total={totalScenarioPages}
            onPage={(p) => runSearch(query, p)}
          />
        )}
      </div>

      {/* ── Right panel: leaderboard ──────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {!selected ? (
          <EmptyState />
        ) : (
          <>
            {/* Scenario header */}
            <div
              style={{
                padding: "14px 20px",
                borderBottom: `1px solid ${BORDER}`,
                background: SIDEBAR_BG,
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: "#fff" }}>
                    {selected.scenario_name}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                    {details?.aim_type && (
                      <Tag>{details.aim_type}</Tag>
                    )}
                    {details?.tags.map((t) => <Tag key={t}>{t}</Tag>)}
                  </div>
                  {details?.description && (
                    <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.5 }}>
                      {details.description}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                  <StatCard label="Players" value={fmt(selected.entry_count)} />
                  <StatCard label="Plays" value={fmt(selected.play_count)} />
                  <StatCard label="Top Score" value={fmtScore(selected.top_score)} accent={ACCENT} />
                  {lbPage && (
                    <StatCard label="Entries" value={lbPage.total.toLocaleString()} />
                  )}
                </div>
              </div>
              {details && (
                <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.28)" }}>
                  {details.author_steam_account_name && `By ${details.author_steam_account_name}`}
                  {details.author_steam_account_name && details.created && " · "}
                  {details.created && `Created ${fmtDate(details.created)}`}
                </div>
              )}
            </div>

            {/* Leaderboard table */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {lbLoading && !lbPage ? (
                <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>
              ) : (
                <LeaderboardTable entries={lbPage?.data ?? []} loading={lbLoading} />
              )}
            </div>

            {/* Leaderboard pagination */}
            {totalLbPages > 1 && (
              <Pagination
                current={lbPageNum}
                total={totalLbPages}
                onPage={goLbPage}
                showingFrom={lbPageNum * PAGE_SIZE + 1}
                showingTo={Math.min((lbPageNum + 1) * PAGE_SIZE, lbPage?.total ?? 0)}
                totalEntries={lbPage?.total}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ScenarioRow({
  scenario,
  active,
  onClick,
}: {
  scenario: ScenarioSearchResult;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "9px 12px",
        cursor: "pointer",
        background: active ? "rgba(0,245,160,0.08)" : "transparent",
        borderLeft: active ? `2px solid ${ACCENT}` : "2px solid transparent",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      <div style={{ fontWeight: active ? 600 : 400, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: active ? "#fff" : "rgba(255,255,255,0.65)", fontSize: 12 }}>
        {scenario.scenario_name}
      </div>
      <div style={{ display: "flex", gap: 8, fontSize: 10, color: MUTED }}>
        {scenario.aim_type && <span>{scenario.aim_type}</span>}
        <span>{fmt(scenario.play_count)} plays</span>
        <span>{fmt(scenario.entry_count)} entries</span>
      </div>
    </div>
  );
}

function LeaderboardTable({ entries, loading }: { entries: LeaderboardEntry[]; loading: boolean }) {
  if (entries.length === 0 && !loading) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center", fontFamily: "'JetBrains Mono', monospace" }}>No entries</div>;
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace" }}>
      <thead>
        <tr style={{ background: BG, position: "sticky", top: 0, zIndex: 1 }}>
          {(["Rank", "Player", "Country", "Score"] as const).map((h) => (
            <th
              key={h}
              style={{
                padding: "9px 14px",
                textAlign: h === "Score" || h === "Rank" ? "right" : "left",
                fontSize: 10,
                fontWeight: 600,
                color: MUTED,
                textTransform: "uppercase",
                letterSpacing: 1,
                borderBottom: `1px solid ${BORDER}`,
                whiteSpace: "nowrap",
                fontFamily: "inherit",
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr
            key={e.rank}
            style={{
              background: "transparent",
              borderBottom: `1px solid ${DIVIDER}`,
              transition: "background 0.1s",
            }}
            onMouseEnter={(el) => { (el.currentTarget as HTMLTableRowElement).style.background = "rgba(255,255,255,0.03)"; }}
            onMouseLeave={(el) => { (el.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
          >
            {/* Rank */}
            <td style={{ padding: "9px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
              <RankBadge rank={e.rank} />
            </td>

            {/* Player */}
            <td style={{ padding: "9px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: e.rank <= 3 ? 700 : 400, fontSize: 13 }}>
                  {e.webapp_username ?? e.steam_account_name}
                </span>
                {e.kovaaks_plus && (
                  <span
                    style={{
                      fontSize: 10,
                      background: "rgba(0,245,160,0.12)",
                      color: ACCENT,
                      border: `1px solid rgba(0,245,160,0.25)`,
                      borderRadius: 4,
                      padding: "1px 5px",
                      fontWeight: 700,
                      flexShrink: 0,
                      letterSpacing: 0.5,
                    }}
                  >
                    PLUS
                  </span>
                )}
                {e.webapp_username && e.webapp_username !== e.steam_account_name && (
                  <span style={{ fontSize: 11, color: MUTED }}>
                    ({e.steam_account_name})
                  </span>
                )}
              </div>
            </td>

            {/* Country */}
            <td style={{ padding: "9px 14px" }}>
              {e.country ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <CountryFlag cc={e.country} />
                  <span style={{ color: MUTED, fontSize: 11 }}>{e.country.toUpperCase()}</span>
                </div>
              ) : (
                <span style={{ color: "rgba(255,255,255,0.15)" }}>—</span>
              )}
            </td>

            {/* Score */}
            <td
              style={{
                padding: "9px 14px",
                textAlign: "right",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: e.rank === 1 ? "#FFD700" : e.rank === 2 ? "#C0C0C0" : e.rank === 3 ? "#CD7F32" : "rgba(255,255,255,0.85)",
                whiteSpace: "nowrap",
              }}
            >
              {fmtScore(e.score)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Pagination({
  current,
  total,
  onPage,
  showingFrom,
  showingTo,
  totalEntries,
}: {
  current: number;
  total: number;
  onPage: (page: number) => void;
  showingFrom?: number;
  showingTo?: number;
  totalEntries?: number;
}) {
  const range: (number | "...")[] = [];
  const delta = 2;
  for (let i = 0; i < total; i++) {
    if (i === 0 || i === total - 1 || Math.abs(i - current) <= delta) {
      range.push(i);
    } else if (range[range.length - 1] !== "...") {
      range.push("...");
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "8px 14px",
        borderTop: `1px solid ${BORDER}`,
        background: SIDEBAR_BG,
        flexShrink: 0,
        flexWrap: "wrap",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {showingFrom !== undefined && totalEntries !== undefined && (
        <span style={{ fontSize: 11, color: MUTED, marginRight: 8 }}>
          {showingFrom}–{showingTo} of {totalEntries.toLocaleString()}
        </span>
      )}
      <PageBtn disabled={current === 0} onClick={() => onPage(current - 1)}>‹</PageBtn>
      {range.map((r, i) =>
        r === "..." ? (
          <span key={`ellipsis-${i}`} style={{ color: MUTED, padding: "0 4px" }}>...</span>
        ) : (
          <PageBtn key={r} active={r === current} onClick={() => onPage(r as number)}>
            {(r as number) + 1}
          </PageBtn>
        )
      )}
      <PageBtn disabled={current >= total - 1} onClick={() => onPage(current + 1)}>›</PageBtn>
    </div>
  );
}

function PageBtn({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: active ? "rgba(0,245,160,0.15)" : "transparent",
        color: active ? ACCENT : disabled ? MUTED : "rgba(255,255,255,0.6)",
        border: `1px solid ${active ? "rgba(0,245,160,0.3)" : BORDER}`,
        borderRadius: 5,
        padding: "3px 9px",
        cursor: disabled ? "default" : "pointer",
        fontSize: 12,
        fontWeight: active ? 700 : 400,
        fontFamily: "inherit",
        transition: "background 0.1s",
        opacity: disabled ? 0.35 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        background: CARD_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        padding: "2px 6px",
        color: MUTED2,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {children}
    </span>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div
      style={{
        background: CARD_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        padding: "10px 14px",
        textAlign: "center",
        minWidth: 70,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: "clamp(14px, 2.5vw, 16px)",
            fontWeight: 700,
            color: accent ?? "#fff",
            lineHeight: 1,
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
      </div>
      <div style={{ fontSize: 10, color: MUTED, marginTop: 3, textTransform: "uppercase", letterSpacing: 0.8 }}>{label}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: MUTED,
        gap: 8,
        padding: 40,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.28)" }}>
        Select a scenario
      </div>
      <div style={{ fontSize: 12, textAlign: "center", maxWidth: 260, color: MUTED, lineHeight: 1.6 }}>
        Search and pick a scenario on the left to view the global leaderboard.
      </div>
    </div>
  );
}

// ─── Embeddable leaderboard panel (used as a tab in Session Stats) ─────────────

export function ScenarioLeaderboardPanel({ scenarioName }: { scenarioName: string }) {
  const [lbPage, setLbPage] = useState<LeaderboardPage | null>(null);
  const [lbPageNum, setLbPageNum] = useState(0);
  const [lbId, setLbId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setLbPage(null);
    setLbPageNum(0);
    resolveScenarioByName(scenarioName)
      .then((match) => {
        if (!match) { setNotFound(true); setLoading(false); return; }
        setLbId(match.leaderboard_id);
        return invoke<LeaderboardPage>("get_leaderboard_page", {
          leaderboardId: match.leaderboard_id,
          page: 0,
          max: PAGE_SIZE,
        });
      })
      .then((lb) => lb && setLbPage(lb))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [scenarioName]);

  function goPage(page: number) {
    if (!lbId) return;
    setLoading(true);
    invoke<LeaderboardPage>("get_leaderboard_page", { leaderboardId: lbId, page, max: PAGE_SIZE })
      .then((r) => { setLbPage(r); setLbPageNum(page); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  const totalPages = lbPage ? Math.ceil(lbPage.total / PAGE_SIZE) : 0;

  if (loading && !lbPage) {
    return (
      <div style={{ padding: 40, color: MUTED, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
        Loading leaderboard...
      </div>
    );
  }
  if (notFound) {
    return (
      <div style={{ padding: 40, color: MUTED, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
        No leaderboard found for this scenario.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {lbPage && (
        <div style={{ fontSize: 11, color: MUTED, paddingBottom: 10, fontFamily: "'JetBrains Mono', monospace" }}>
          {lbPage.total.toLocaleString()} entries
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <LeaderboardTable entries={lbPage?.data ?? []} loading={loading} />
      </div>
      {totalPages > 1 && (
        <Pagination
          current={lbPageNum}
          total={totalPages}
          onPage={goPage}
          showingFrom={lbPageNum * PAGE_SIZE + 1}
          showingTo={Math.min((lbPageNum + 1) * PAGE_SIZE, lbPage?.total ?? 0)}
          totalEntries={lbPage?.total}
        />
      )}
    </div>
  );
}
