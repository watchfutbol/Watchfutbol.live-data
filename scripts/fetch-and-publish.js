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
// API-Football's /leagues search endpoint. `country`, if set, is used to pick
// the right result AFTER searching (the API rejects sending `search` and
// `country` in the same request — "The Country field cannot be used with the
// Search field" — found from a real run's logs on 2026-08-15). `displayName`
// is the exact string used throughout the WatchFutbol Base44 app (must match,
// including spelling like "La Liga" with a space) so the Review Queue can
// match leagues correctly.
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

// Free-plan requests are rate-limited per minute (a real run hit this on
// 2026-08-15 after ~8 rapid calls). Spacing every call out by this much and
// running everything sequentially (no Promise.all) keeps us well under it.
// 14 leagues x up to 5 calls each x 8s = ~9-10 minutes total, which is fine
// for a once-a-day background job.
const REQUEST_DELAY_MS = 8000;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(path, params) {
  const url = new URL(API_BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
  await sleep(REQUEST_DELAY_MS); // always pace, even after a failed call
  if (!res.ok) {
    throw new Error(`API-Football request failed (${res.status}) for ${url}`);
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    const message = Object.values(json.errors).join("; ");
    const err = new Error(message);
    err.isApiError = true;
    throw err;
  }
  return json.response;
}

// Resolve a league's numeric id + current season year by searching by name
// only (no country param — see note above), then picking the best match
// from the results using the country client-side, if one was given.
async function resolveLeague(entry) {
  const results = await apiGet("/leagues", { search: entry.searchTerm });
  if (!results || results.length === 0) {
    return { error: `No API-Football match found for search "${entry.searchTerm}"` };
  }

  let candidates = results;
  if (entry.country) {
    const inCountry = results.filter(
      (r) => r.country?.name?.toLowerCase() === entry.country.toLowerCase()
    );
    if (inCountry.length > 0) candidates = inCountry;
  }

  const best =
    candidates.find(
      (r) => r.league.name.toLowerCase() === entry.searchTerm.toLowerCase()
    ) || candidates[0];

  const currentSeason = best.seasons.find((s) => s.current) || best.seasons.at(-1);
  if (!currentSeason) {
    return { error: `No season data found for "${entry.displayName}" (matched API league "${best.league.name}")` };
  }

  return {
    id: best.league.id,
    apiName: best.league.name,
    season: currentSeason.year,
  };
}

async function fetchLeagueData(entry) {
  const resolved = await resolveLeague(entry);
  if (resolved.error) {
    return { matches: [], standings: [], scorers: [], note: resolved.error };
  }

  const today = new Date();
  const future = new Date(today);
  future.setDate(future.getDate() + DAYS_AHEAD);
  const past = new Date(today);
  past.setDate(past.getDate() - DAYS_BACK);

  // Sequential, not Promise.all — keeps request pacing predictable.
  let upcoming = [];
  let recentlyFinished = [];
  let standingsResp = [];
  let topScorers = [];
  const notes = [];

  try {
    upcoming = await apiGet("/fixtures", {
      league: resolved.id,
      season: resolved.season,
      from: isoDate(today),
      to: isoDate(future),
    });
  } catch (err) {
    notes.push(`upcoming fixtures: ${err.message}`);
  }

  try {
    recentlyFinished = await apiGet("/fixtures", {
      league: resolved.id,
      season: resolved.season,
      from: isoDate(past),
      to: isoDate(today),
      status: "FT",
    });
  } catch (err) {
    notes.push(`recent results: ${err.message}`);
  }

  try {
    standingsResp = await apiGet("/standings", { league: resolved.id, season: resolved.season });
  } catch (err) {
    notes.push(`standings: ${err.message}`);
  }

  try {
    topScorers = await apiGet("/players/topscorers", { league: resolved.id, season: resolved.season });
  } catch (err) {
    notes.push(`top scorers: ${err.message}`);
  }

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

  return {
    matches,
    standings,
    scorers,
    note: notes.length ? notes.join(" | ") : undefined,
  };
}

async function main() {
  const out = { generated_at: new Date().toISOString(), leagues: {} };

  for (const entry of LEAGUES) {
    console.log(`Fetching ${entry.displayName}...`);
    try {
      out.leagues[entry.displayName] = await fetchLeagueData(entry);
      const l = out.leagues[entry.displayName];
      if (l.note) {
        console.warn(`  ${entry.displayName}: ${l.note}`);
      } else {
        console.log(`  ${entry.displayName}: ${l.matches.length} matches, ${l.standings.length} standings rows, ${l.scorers.length} scorers`);
      }
    } catch (err) {
      console.error(`Failed to fetch ${entry.displayName}:`, err.message);
      out.leagues[entry.displayName] = { matches: [], standings: [], scorers: [], note: `fetch failed: ${err.message}` };
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
