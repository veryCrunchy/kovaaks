// ─── Friend profiles ───────────────────────────────────────────────────────────

export interface FriendProfile {
  username: string;
  steam_id: string;
  steam_account_name: string;
  avatar_url: string;
  country: string;
  kovaaks_plus: boolean;
}

export interface MostPlayedEntry {
  scenario_name: string;
  score: number;
  rank: number | null;
  counts: { plays: number };
}

/** Best score fetched from KovaaK's API for a friend on a specific scenario. */
export interface FriendScore {
  username: string;
  score: number;
}
