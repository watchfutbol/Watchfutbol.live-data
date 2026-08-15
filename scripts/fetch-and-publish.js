// WatchFutbol data fetcher
//
// Pulls fixtures, final scores, standings, and top scorers for all 14 tracked
// competitions from API-Football (https://www.api-football.com) and writes a
// single JSON snapshot to data/watchfutbol-feed.json. That file gets committed
// back to the repo by the GitHub Actions workflow, and the WatchFutbol Review
// Queue (in Base44) reads it from its public raw.githubusercontent.com URL.
//
// This script does NOT write anything into Base44 directly — it only produces
// a public data file. All approval/publishing happens inside the app, where
// Luis reviews and clicks Approve/Edit/Reject.
//
// Runs on Node 18+ (GitHub Actions' ubuntu-latest image has this built in),
// using the native fetch() API — no extra dependencies needed.

const API_BASE = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY;

if (!API_KEY) {
  console.error("Missing API_FOOTBALL_KEY environment variable.");
  process.exit(1);
}

// The 14 competitions WatchFutbol tracks. `searchTerm` is what gets sent to
// API-Football's /leagues search endpoint; `country` narrows the search when
// a league name alone is ambiguous. `displayName` is the exact string used
// throughout the WatchFutbol Base44 app (must match, including spelling like
// "La Liga" with a space) so the Review Queue can match leagues correctly.
const LEAGUES = [
  { displayName: "Premier League", searchTerm: "Premier League", country: "England" },
  { displayName: "La Liga", searchTerm: "La Liga", country: "Spain" },
  { displayName: "Bundesliga", searchTerm: "Bundesliga", country: "Germany" },
  { displayName: "Serie A", searchTerm: "Serie A", country: "Italy" },
  { displayName: "Ligue 1", searchTerm: "Ligue 1", country: "France" },
  { displayName: "MLS", searchTerm: "MLS", country: "USA" },
  { displayName: "Leagues Cup", searchTerm: "Leagues Cup" },
  { displayName: "Liga DIMAYOR", searchTerm: "Primera A", country: "Colombia" },
  { displayName: "Copa Colombia", searchTerm: "Copa Colombia", country: "Colombia" },
  { displayName: "Copa Sudamericana", searchTerm: "Copa Sudamericana" },
  { displayName: "Copa Libertadores", searchTerm: "Copa Libertadores" },
  { displayName: "Champions League", searchTerm: "UEFA Champions League" },
  { displayName: "Europa League", searchTerm: "UEFA Europa League" },
  { displayName: "Europa Conference League", searchTerm: "UEFA Europa Conference League" },
];

const DAYS_AHEAD = 14; // how far into the future to pull upcoming fixtures
const DAYS_BACK = 14; // how far back to check for newly-finished matches

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function apiGet(path, params) {
  const url = new URL(API_BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
  if (!res.ok) {
    throw new Error(`API-Football request failed (${res.status}) for ${url}`);
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    console.warn(`API-Football returned errors for ${url}:`, json.errors);
  }
  return json.response;
}

// Resolve a league's numeric id + current season year by searching by name.
// Doing this dynamically (instead of hardcoding ids) avoids shipping guessed
// or stale ids — API-Football's ids and current-season flags are the source
// of truth.
async function resolveLeague(entry) {
  const results = await apiGet("/leagues", {
    search: entry.searchTerm,
    country: entry.country,
  });
  if (!results || results.length === 0) {
    console.warn(`No API-Football match found for "${entry.displayName}" (search="${entry.searchTerm}")`);
    return null;
  }
  // Prefer an exact (case-insensitive) name match; fall back to the first result.
  const best =
    results.find(
      (r) => r.league.name.toLowerCase() === entry.searchTerm.toLowerCase()
    ) || results[0];
  const currentSeason = best.seasons.find((s) => s.current) || best.seasons.at(-1);
  if (!currentSeason) {
    console.warn(`No season data for "${entry.displayName}" (matched "${best.league.name}")`);
    return null;
  }
  return {
    id: best.league.id,
    apiName: best.league.name,
    season: currentSeason.year,
  };
}

async function fetchLeagueData(entry) {
  const resolved = await resolveLeague(entry);
  if (!resolved) return null;

  const today = new Date();
  const future = new Date(today);
  future.setDate(future.getDate() + DAYS_AHEAD);
  const past = new Date(today);
  past.setDate(past.getDate() - DAYS_BACK);

  const [upcoming, recentlyFinished, standingsResp, topScorers] = await Promise.all([
    apiGet("/fixtures", {
      league: resolved.id,
      season: resolved.season,
      from: isoDate(today),
      to: isoDate(future),
    }),
    apiGet("/fixtures", {
      league: resolved.id,
      season: resolved.season,
      from: isoDate(past),
      to: isoDate(today),
      status: "FT",
    }),
    apiGet("/standings", { league: resolved.id, season: resolved.season }),
    apiGet("/players/topscorers", { league: resolved.id, season: resolved.season }),
  ]);

  const matches = [...(upcoming || []), ...(recentlyFinished || [])].map((f) => ({
    league: entry.displayName,
    match_date: f.fixture.date.slice(0, 10),
    kickoff_utc: f.fixture.date.slice(11, 16), // "HH:MM" in UTC
    home_team: f.teams.home.name,
    away_team: f.teams.away.name,
    status: f.fixture.status.short === "FT" ? "Final" : "Scheduled",
    home_score: f.fixture.status.short === "FT" ? f.goals.home : null,
    away_score: f.fixture.status.short === "FT" ? f.goals.away : null,
  }));

  // standings[0].league.standings is an array of arrays: one inner array per
  // group/conference. For a league with no groups there's just one.
  const groups = standingsResp?.[0]?.league?.standings || [];
  const standings = groups.flatMap((group) =>
    group.map((row) => ({
      league: entry.displayName,
      conference: groups.length > 1 ? row.group || "" : "",
      position: row.rank,
      team_name: row.team.name,
      matches_played: row.all.played,
      wins: row.all.win,
      draws: row.all.draw,
      losses: row.all.lose,
      goal_difference: row.goalsDiff,
      points: row.points,
    }))
  );

  const scorers = (topScorers || []).slice(0, 5).map((p) => ({
    league: entry.displayName,
    player_name: p.player.name,
    team_name: p.statistics?.[0]?.team?.name || "",
    goals: p.statistics?.[0]?.goals?.total || 0,
  }));

  return { matches, standings, scorers };
}

async function main() {
  const out = { generated_at: new Date().toISOString(), leagues: {} };

  for (const entry of LEAGUES) {
    try {
      console.log(`Fetching ${entry.displayName}...`);
      const data = await fetchLeagueData(entry);
      if (data) out.leagues[entry.displayName] = data;
    } catch (err) {
      console.error(`Failed to fetch ${entry.displayName}:`, err.message);
      // Keep going — one league failing shouldn't blank out the rest of the feed.
    }
  }

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(
    "data/watchfutbol-feed.json",
    JSON.stringify(out, null, 2)
  );
  console.log("Wrote data/watchfutbol-feed.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
