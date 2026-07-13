#!/usr/bin/env node
/**
 * update-readme.js
 *
 * Builds a real, fun-toned activity feed for a GitHub organization profile README,
 * by aggregating commits, issues, pull requests, and releases across every repo
 * in the org (excluding the `.github` profile repo itself).
 *
 * Replaces the unreliable GET /orgs/{org}/events endpoint entirely.
 *
 * Requires: Node.js 18+, @octokit/rest
 * Env vars:
 *   GITHUB_TOKEN  - token with repo read access (provided by Actions automatically)
 *   GITHUB_ORG    - org login (defaults to "anarnapr")
 *   GITHUB_REPOSITORY - "owner/repo" of the .github profile repo (set automatically in Actions)
 */

"use strict";

const fs = require("fs/promises");
const path = require("path");
const { Octokit } = require("@octokit/rest");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ORG = process.env.GITHUB_ORG || "anarnapr";
const IGNORED_REPOS = new Set([".github"]);

const README_PATH = path.join(process.cwd(), "profile", "README.md");
const START_MARKER = "<!--START_ACTIVITY-->";
const END_MARKER = "<!--END_ACTIVITY-->";

const SVG_OUTPUT_PATH = path.join(process.cwd(), "profile", "assets", "skyline.svg");
const SVG_RELATIVE_PATH = "./assets/skyline.svg"; // as referenced from README.md
const SKYLINE_START_MARKER = "<!--START_SKYLINE-->";
const SKYLINE_END_MARKER = "<!--END_SKYLINE-->";
const STATS_RETRY_ATTEMPTS = 5; // GitHub computes stats lazily; 202 means "still baking"
const STATS_RETRY_DELAY_MS = 1500;

const MAX_FEED_ITEMS = 10;
const PER_REPO_FETCH_LIMIT = 5; // how many of each event type to pull per repo
const REPO_CONCURRENCY = 4; // how many repos to process in parallel
const MIN_REMAINING_RATE_LIMIT = 100; // safety floor; stop fetching more if we dip below this

const LEADERBOARD_START_MARKER = "<!--START_LEADERBOARD-->";
const LEADERBOARD_END_MARKER = "<!--END_LEADERBOARD-->";
const MAX_LEADERBOARD_REPOS = 5;
// Relative weight of each event type when scoring "most active repo". Releases
// and PRs represent more finished work than a single commit, so they count for more.
const ACTIVITY_WEIGHTS = { commit: 1, issue: 2, pull_request: 3, release: 5 };
const MEDALS = ["🥇", "🥈", "🥉"];

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  userAgent: "org-activity-feed-script",
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Sleep helper, used for gentle backoff between repo batches. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pick a random element from an array. */
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Split an array into chunks of a given size, for batching repo processing. */
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Reads the current GitHub API rate-limit status from Octokit.
 * Returns Infinity-safe defaults if the call fails, so we never block on this.
 */
async function getRemainingRateLimit() {
  try {
    const { data } = await octokit.rest.rateLimit.get();
    return data.resources.core.remaining;
  } catch {
    return Infinity;
  }
}

// ---------------------------------------------------------------------------
// Step 1: Fetch every repository in the organization (paginated, .github excluded)
// ---------------------------------------------------------------------------

async function fetchOrgRepos() {
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: ORG,
    type: "all",
    per_page: 100,
  });

  return repos
    .filter((repo) => !IGNORED_REPOS.has(repo.name))
    .filter((repo) => !repo.archived) // archived repos rarely have fresh activity worth surfacing
    .map((repo) => ({
      name: repo.name,
      owner: repo.owner.login,
      defaultBranch: repo.default_branch || "main",
    }));
}

// ---------------------------------------------------------------------------
// Step 2: Fetch recent commits / issues / pulls / releases for a single repo
// ---------------------------------------------------------------------------

/** Fetch recent commits for a repo. Returns [] on any failure (e.g. empty repo). */
async function fetchCommits(repo) {
  try {
    const { data } = await octokit.rest.repos.listCommits({
      owner: repo.owner,
      repo: repo.name,
      per_page: PER_REPO_FETCH_LIMIT,
    });

    return data.map((commit) => ({
      type: "commit",
      title: firstLine(commit.commit.message),
      repo: repo.name,
      user: commit.author?.login || commit.commit.author?.name || "someone",
      date: commit.commit.author?.date || commit.commit.committer?.date,
      url: commit.html_url,
    }));
  } catch (error) {
    // Empty repos (no commits yet) return 409 Conflict - treat as "no activity"
    if (error.status !== 409) {
      console.warn(`commits fetch failed for ${repo.owner}/${repo.name}:`, error.status, error.message);
    }
    return [];
  }
}

/**
 * Fetch recent issues for a repo.
 * Note: GitHub's /issues endpoint also returns pull requests. We filter those
 * out here since PRs are fetched separately via fetchPullRequests(), to avoid
 * double-counting the same item as both an "issue" and a "pull_request" event.
 */
async function fetchIssues(repo) {
  try {
    const { data } = await octokit.rest.issues.listForRepo({
      owner: repo.owner,
      repo: repo.name,
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: PER_REPO_FETCH_LIMIT,
    });

    return data
      .filter((issue) => !issue.pull_request) // exclude PRs masquerading as issues
      .map((issue) => ({
        type: "issue",
        title: issue.title,
        repo: repo.name,
        user: issue.user?.login || "someone",
        date: issue.created_at,
        url: issue.html_url,
        state: issue.state, // "open" | "closed"
        labels: (issue.labels || [])
          .map((label) => (typeof label === "string" ? label : label.name))
          .filter(Boolean),
      }));
  } catch (error) {
    console.warn(`issues fetch failed for ${repo.owner}/${repo.name}:`, error.status, error.message);
    return [];
  }
}
async function fetchPullRequests(repo) {
  try {
    const { data } = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: PER_REPO_FETCH_LIMIT,
    });

    return data.map((pr) => ({
      type: "pull_request",
      title: pr.title,
      repo: repo.name,
      user: pr.user?.login || "someone",
      date: pr.created_at,
      url: pr.html_url,
    }));
  } catch (error) {
    console.warn(`pulls fetch failed for ${repo.owner}/${repo.name}:`, error.status, error.message);
    return [];
  }
}

/** Fetch recent releases for a repo. Returns [] if the repo has no releases. */
async function fetchReleases(repo) {
  try {
    const { data } = await octokit.rest.repos.listReleases({
      owner: repo.owner,
      repo: repo.name,
      per_page: PER_REPO_FETCH_LIMIT,
    });

    return data.map((release) => ({
      type: "release",
      title: release.name || release.tag_name,
      repo: repo.name,
      user: release.author?.login || "someone",
      date: release.published_at || release.created_at,
      url: release.html_url,
    }));
  } catch (error) {
    console.warn(`releases fetch failed for ${repo.owner}/${repo.name}:`, error.status, error.message);
    return [];
  }
}

/** Extracts the first line of a (possibly multi-line) commit message. */
function firstLine(message) {
  return (message || "").split("\n")[0].trim() || "(no message)";
}

/**
 * Fetches all four event types for a single repo concurrently.
 * Each fetcher already swallows its own errors, so this never throws.
 */
async function fetchRepoActivity(repo) {
  const [commits, issues, pulls, releases] = await Promise.all([
    fetchCommits(repo),
    fetchIssues(repo),
    fetchPullRequests(repo),
    fetchReleases(repo),
  ]);

  return [...commits, ...issues, ...pulls, ...releases];
}

// ---------------------------------------------------------------------------
// Step 2b (orchestration): walk all repos in small concurrent batches,
// respecting rate limits and never letting one repo's failure kill the run.
// ---------------------------------------------------------------------------

async function fetchAllActivity(repos) {
  const allEvents = [];
  const batches = chunk(repos, REPO_CONCURRENCY);

  for (const batch of batches) {
    const remaining = await getRemainingRateLimit();
    if (remaining < MIN_REMAINING_RATE_LIMIT) {
      console.warn(
        `Rate limit low (${remaining} remaining). Stopping early with partial data.`
      );
      break;
    }

    const results = await Promise.allSettled(
      batch.map((repo) => fetchRepoActivity(repo))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        allEvents.push(...result.value);
      } else {
        console.warn("A repo failed to fetch activity:", result.reason?.message);
      }
    }

    // Gentle pacing between batches to be a good API citizen.
    await sleep(250);
  }

  return allEvents;
}

// ---------------------------------------------------------------------------
// Step 3 & 4: Deduplicate, sort newest-first, take top N
// ---------------------------------------------------------------------------

function dedupeEvents(events) {
  const seen = new Set();
  const deduped = [];

  for (const event of events) {
    const key = `${event.type}:${event.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

function sortAndTrim(events, limit) {
  return [...events]
    .filter((event) => event.date) // guard against malformed entries
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Step 5: Fun text generation
// ---------------------------------------------------------------------------

const COMMIT_PHRASES = [
  (u, r) => `${u} has been cooking in \`${r}\`.`,
  (u, r) => `Someone trusted ${u} with \`${r}\` again.`,
  (u, r) => `Fresh code just landed in \`${r}\`.`,
  (u, r) => `${u} pushed something into \`${r}\`. Probably fine.`,
  (u, r) => `Another commit sneaks into \`${r}\`.`,
];

const ISSUE_PHRASES = [
  (u, r) => `${u} found something suspicious in \`${r}\`.`,
  (u, r) => `Another mystery appeared in \`${r}\`.`,
  () => `A new quest has been added.`,
  (u, r) => `${u} has questions about \`${r}\`.`,
  (u, r) => `Something's not quite right in \`${r}\`, apparently.`,
];

const PR_PHRASES = [
  (u) => `${u} thinks this code is ready.`,
  () => `Merge button anxiety has begun.`,
  (u) => `Someone is asking for reviews from ${u}.`,
  (u, r) => `${u} is proposing changes to \`${r}\`.`,
  (u, r) => `A pull request quietly enters \`${r}\`.`,
];

const RELEASE_PHRASES = [
  () => `Fresh release just dropped.`,
  () => `Production received another surprise.`,
  () => `New version escaped into the wild.`,
  (u, r) => `${u} shipped a new version of \`${r}\`.`,
  (u, r) => `\`${r}\` levels up to a new release.`,
];

const PHRASES_BY_TYPE = {
  commit: COMMIT_PHRASES,
  issue: ISSUE_PHRASES,
  pull_request: PR_PHRASES,
  release: RELEASE_PHRASES,
};

function generateFunText(event) {
  const phrases = PHRASES_BY_TYPE[event.type] || [];
  if (phrases.length === 0) return event.title;

  const template = pick(phrases);
  return template(event.user, event.repo);
}

// ---------------------------------------------------------------------------
// Step 6: Render markdown and splice it into the README between markers
// ---------------------------------------------------------------------------

/** Builds the "— 🟢 open · `bug` `priority:high`" suffix shown after issue lines. */
function issueDetailSuffix(event) {
  if (event.type !== "issue") return "";

  const statusBadge = event.state === "closed" ? "🔴 closed" : "🟢 open";
  const labelBadges = (event.labels || []).map((label) => `\`${label}\``).join(" ");

  return labelBadges ? ` — ${statusBadge} · ${labelBadges}` : ` — ${statusBadge}`;
}

function renderActivityMarkdown(events) {
  if (events.length === 0) {
    return "Everyone is suspiciously quiet right now...";
  }

  return events
    .map((event) => {
      const funText = generateFunText(event);
      return `* [${funText}](${event.url})${issueDetailSuffix(event)}`;
    })
    .join("\n");
}

async function updateReadme(activityMarkdown) {
  const original = await fs.readFile(README_PATH, "utf8");

  const startIndex = original.indexOf(START_MARKER);
  const endIndex = original.indexOf(END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `Could not find ${START_MARKER} / ${END_MARKER} markers in ${README_PATH}`
    );
  }

  const before = original.slice(0, startIndex + START_MARKER.length);
  const after = original.slice(endIndex);

  const updated = `${before}\n\n${activityMarkdown}\n\n${after}`;

  if (updated === original) {
    console.log("No content changes to README.");
    return false;
  }

  await fs.writeFile(README_PATH, updated, "utf8");
  console.log("README updated.");
  return true;
}

// ---------------------------------------------------------------------------
// Step 6b: Repo vs. repo leaderboard - "most active repo" competition, scored
// from the same events already fetched for the activity feed (no extra API
// calls). Because each fetcher is capped at PER_REPO_FETCH_LIMIT, this is a
// recency-weighted signal ("who's been busiest lately"), not a lifetime total.
// ---------------------------------------------------------------------------

function computeRepoLeaderboard(events) {
  const scoreByRepo = new Map();

  for (const event of events) {
    const weight = ACTIVITY_WEIGHTS[event.type] || 0;
    scoreByRepo.set(event.repo, (scoreByRepo.get(event.repo) || 0) + weight);
  }

  return [...scoreByRepo.entries()]
    .map(([repo, score]) => ({ repo, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LEADERBOARD_REPOS);
}

function renderLeaderboardMarkdown(leaderboard) {
  if (leaderboard.length === 0) {
    return "No repo has claimed the crown yet...";
  }

  return leaderboard
    .map((entry, index) => {
      const rank = MEDALS[index] || `${index + 1}.`;
      return `${rank} \`${entry.repo}\` — ${entry.score} activity pts`;
    })
    .join("\n");
}

async function updateReadmeLeaderboard(leaderboardMarkdown) {
  const original = await fs.readFile(README_PATH, "utf8");

  const startIndex = original.indexOf(LEADERBOARD_START_MARKER);
  const endIndex = original.indexOf(LEADERBOARD_END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    console.warn(
      `Could not find ${LEADERBOARD_START_MARKER} / ${LEADERBOARD_END_MARKER} markers in ${README_PATH}; skipping leaderboard embed.`
    );
    return;
  }

  const before = original.slice(0, startIndex + LEADERBOARD_START_MARKER.length);
  const after = original.slice(endIndex);
  const updated = `${before}\n\n${leaderboardMarkdown}\n\n${after}`;

  if (updated === original) {
    console.log("No leaderboard changes needed.");
    return;
  }

  await fs.writeFile(README_PATH, updated, "utf8");
  console.log("README updated with repo leaderboard.");
}

// ---------------------------------------------------------------------------
// Step 7: Contribution skyline - daily commit activity rendered as a 3D
// isometric SVG skyline (buildings = days, height = commit volume), spliced
// into the README the same way the activity feed is above.
// ---------------------------------------------------------------------------

/**
 * GET /repos/{owner}/{repo}/stats/commit_activity returns 202 while GitHub
 * computes the cache. We poll a few times before giving up on that repo.
 * Returns an array of 52 { week: unixTimestamp, total, days: [7 ints] }.
 */
async function fetchCommitActivity(repo) {
  for (let attempt = 0; attempt < STATS_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await octokit.rest.repos.getCommitActivityStats({
        owner: repo.owner,
        repo: repo.name,
      });

      if (response.status === 202) {
        await sleep(STATS_RETRY_DELAY_MS);
        continue;
      }

      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      if (error.status === 202) {
        await sleep(STATS_RETRY_DELAY_MS);
        continue;
      }
      console.warn(`stats fetch failed for ${repo.owner}/${repo.name}:`, error.status, error.message);
      return [];
    }
  }
  console.warn(`stats never became ready for ${repo.owner}/${repo.name}, skipping`);
  return [];
}

async function fetchAllCommitActivity(repos) {
  const perRepo = [];
  const batches = chunk(repos, REPO_CONCURRENCY);

  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((repo) => fetchCommitActivity(repo)));
    for (const result of results) {
      if (result.status === "fulfilled") perRepo.push(result.value);
      else console.warn("A repo failed to fetch commit activity:", result.reason?.message);
    }
    await sleep(200);
  }

  return perRepo;
}

/**
 * Aggregates per-repo weekly stats into a single 52 x 7 grid, keyed by
 * week-start timestamp so results line up even if repos were computed at
 * slightly different times.
 */
function aggregateGrid(perRepoWeeks) {
  const byWeek = new Map(); // weekTimestamp -> [7 counts]

  for (const weeks of perRepoWeeks) {
    for (const w of weeks) {
      const existing = byWeek.get(w.week) || [0, 0, 0, 0, 0, 0, 0];
      for (let d = 0; d < 7; d++) existing[d] += w.days[d] || 0;
      byWeek.set(w.week, existing);
    }
  }

  const sortedWeeks = [...byWeek.keys()].sort((a, b) => a - b);
  return sortedWeeks.map((weekTs) => ({
    weekStart: new Date(weekTs * 1000),
    days: byWeek.get(weekTs),
  }));
}

/**
 * GitHub-style intensity buckets: 0 = none, then quartiles of the nonzero
 * values become levels 1-4.
 */
function computeLevels(grid) {
  const nonZero = grid
    .flatMap((w) => w.days)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);

  if (nonZero.length === 0) return () => 0;

  const q = (p) => nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))];
  const thresholds = [q(0.25), q(0.5), q(0.75)];

  return (count) => {
    if (count <= 0) return 0;
    if (count <= thresholds[0]) return 1;
    if (count <= thresholds[1]) return 2;
    if (count <= thresholds[2]) return 3;
    return 4;
  };
}

const TILE_W = 18; // isometric tile width (px)
const TILE_H = 9; // isometric tile height (px, 2:1 iso ratio)
const MAX_BUILDING_H = 46; // px, tallest possible building
const BASE_H = 4; // px, minimum "slab" height so empty days still read as ground tiles

// Level -> [top, left, right] face colors. Dusk-skyline palette: quiet
// building blocks that light up like windows as activity increases.
const LEVEL_COLORS = [
  ["#232946", "#181c33", "#1d2140"], // 0: dark, unlit block
  ["#2e3a6b", "#212a4e", "#27325c"], // 1
  ["#3d63c9", "#2a468f", "#3355ac"], // 2
  ["#5ab0ff", "#3a7fce", "#4695e8"], // 3
  ["#8fe3ff", "#4fb8e6", "#6bcdf5"], // 4: brightest, "fully lit"
];

function isoPoint(col, row, elevation = 0) {
  const x = (col - row) * (TILE_W / 2);
  const y = (col + row) * (TILE_H / 2) - elevation;
  return { x, y };
}

function poly(points) {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function buildingSVG(col, row, height, level) {
  const [topColor, leftColor, rightColor] = LEVEL_COLORS[level];
  const h = BASE_H + height;

  const N = isoPoint(col, row - 0.5);
  const E = isoPoint(col + 0.5, row);
  const S = isoPoint(col, row + 0.5);
  const W = isoPoint(col - 0.5, row);

  const Nt = { x: N.x, y: N.y - h };
  const Et = { x: E.x, y: E.y - h };
  const St = { x: S.x, y: S.y - h };
  const Wt = { x: W.x, y: W.y - h };

  const top = `<polygon points="${poly([Nt, Et, St, Wt])}" fill="${topColor}" />`;
  const left = `<polygon points="${poly([W, S, St, Wt])}" fill="${leftColor}" />`;
  const right = `<polygon points="${poly([S, E, Et, St])}" fill="${rightColor}" />`;

  // Window glints on lit buildings only - a couple of small rects on the right face.
  let windows = "";
  if (level >= 2 && height > 10) {
    const rows = Math.min(4, Math.floor(height / 10));
    for (let i = 0; i < rows; i++) {
      const t = (i + 1) / (rows + 1);
      const wx = S.x + (E.x - S.x) * 0.5;
      const wy = S.y - h * t;
      windows += `<rect x="${(wx - 1.2).toFixed(1)}" y="${(wy - 1).toFixed(1)}" width="2.4" height="1.6" fill="#fff7cf" opacity="0.85" />`;
    }
  }

  return `<g>${left}${right}${top}${windows}</g>`;
}

function renderSkylineSVG(grid) {
  const levelOf = computeLevels(grid);
  const maxCount = Math.max(1, ...grid.flatMap((w) => w.days));

  const numWeeks = grid.length;
  const numDays = 7;

  const corners = [
    isoPoint(0, -0.5, MAX_BUILDING_H + BASE_H),
    isoPoint(numWeeks - 0.5, -0.5, MAX_BUILDING_H + BASE_H),
    isoPoint(0, numDays - 0.5, 0),
    isoPoint(numWeeks - 0.5, numDays - 0.5, 0),
  ];
  const minX = Math.min(...corners.map((p) => p.x));
  const maxX = Math.max(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxY = Math.max(...corners.map((p) => p.y));

  const pad = 20;
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;
  const offsetX = -minX + pad;
  const offsetY = -minY + pad;

  // Paint buildings back-to-front (by col+row, i.e. iso depth) so nearer
  // buildings correctly overlap farther ones.
  const cells = [];
  for (let col = 0; col < numWeeks; col++) {
    for (let row = 0; row < numDays; row++) {
      const count = grid[col].days[row];
      const level = levelOf(count);
      const buildingHeight = Math.round((count / maxCount) * MAX_BUILDING_H);
      cells.push({ col, row, level, buildingHeight, depth: col + row });
    }
  }
  cells.sort((a, b) => a.depth - b.depth);

  const buildingsSVG = cells
    .map((c) => buildingSVG(c.col, c.row, c.buildingHeight, c.level))
    .join("\n");

  const totalCommits = grid.reduce((sum, w) => sum + w.days.reduce((a, b) => a + b, 0), 0);

  return `<svg viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" xmlns="http://www.w3.org/2000/svg" font-family="'Segoe UI', system-ui, sans-serif">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d1128" />
      <stop offset="55%" stop-color="#241b4e" />
      <stop offset="100%" stop-color="#4a2b6b" />
    </linearGradient>
    <radialGradient id="moon" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff7dc" />
      <stop offset="100%" stop-color="#ffe9a8" />
    </radialGradient>
  </defs>

  <rect x="0" y="0" width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="url(#sky)" rx="12" />
  <circle cx="${(width - 46).toFixed(1)}" cy="42" r="16" fill="url(#moon)" opacity="0.9" />
  ${[...Array(24)].map(() => {
    const sx = (Math.random() * (width - 20) + 10).toFixed(1);
    const sy = (Math.random() * (height * 0.35) + 8).toFixed(1);
    const r = (Math.random() * 0.9 + 0.4).toFixed(1);
    return `<circle cx="${sx}" cy="${sy}" r="${r}" fill="#ffffff" opacity="${(Math.random() * 0.5 + 0.3).toFixed(2)}" />`;
  }).join("\n  ")}

  <g transform="translate(${offsetX.toFixed(1)}, ${offsetY.toFixed(1)})">
    ${buildingsSVG}
  </g>

  <text x="16" y="${(height - 14).toFixed(1)}" fill="#cfd6ff" font-size="11" opacity="0.85">${ORG} · ${totalCommits.toLocaleString()} commits in the last year</text>
</svg>`;
}

async function writeSkylineSVG(svg) {
  await fs.mkdir(path.dirname(SVG_OUTPUT_PATH), { recursive: true });
  await fs.writeFile(SVG_OUTPUT_PATH, svg, "utf8");
  console.log(`Wrote ${SVG_OUTPUT_PATH}`);
}

async function updateReadmeSkyline() {
  const original = await fs.readFile(README_PATH, "utf8");

  const startIndex = original.indexOf(SKYLINE_START_MARKER);
  const endIndex = original.indexOf(SKYLINE_END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    console.warn(
      `Could not find ${SKYLINE_START_MARKER} / ${SKYLINE_END_MARKER} markers in ${README_PATH}; skipping skyline embed.`
    );
    return;
  }

  // Cache-bust with a timestamp query param so GitHub's camo proxy / browser
  // cache picks up the new SVG on every run.
  const cacheBust = Date.now();
  const imgTag = `<img src="${SVG_RELATIVE_PATH}?v=${cacheBust}" alt="${ORG} activity skyline" width="100%" />`;

  const before = original.slice(0, startIndex + SKYLINE_START_MARKER.length);
  const after = original.slice(endIndex);
  const updated = `${before}\n\n${imgTag}\n\n${after}`;

  if (updated === original) {
    console.log("No skyline changes needed.");
    return;
  }

  await fs.writeFile(README_PATH, updated, "utf8");
  console.log("README updated with skyline image.");
}

async function generateSkyline(repos) {
  console.log("Fetching commit activity stats for skyline (this can take a bit on first run)...");
  const perRepoWeeks = await fetchAllCommitActivity(repos);

  const grid = aggregateGrid(perRepoWeeks);
  console.log(`Aggregated ${grid.length} week(s) of activity for skyline.`);

  const svg = renderSkylineSVG(grid);
  await writeSkylineSVG(svg);
  await updateReadmeSkyline();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Fetching repositories for org: ${ORG}`);
  const repos = await fetchOrgRepos();
  console.log(`Found ${repos.length} repo(s) to scan (excluding .github).`);
  console.log("Repos:", repos.map((r) => `${r.owner}/${r.name}`).join(", "));

  if (repos.length === 0) {
    await updateReadme("Everyone is suspiciously quiet right now...");
    return;
  }

  console.log("Fetching activity across all repos...");
  const rawEvents = await fetchAllActivity(repos);
  console.log(`Collected ${rawEvents.length} raw event(s).`);

  const deduped = dedupeEvents(rawEvents);
  const topEvents = sortAndTrim(deduped, MAX_FEED_ITEMS);
  console.log(`Selected top ${topEvents.length} event(s) after dedupe/sort.`);

  const markdown = renderActivityMarkdown(topEvents);
  await updateReadme(markdown);

  // Leaderboard uses the full deduped set (not just the trimmed top 10) so
  // quieter-but-steady repos aren't invisible next to one very chatty repo.
  const leaderboard = computeRepoLeaderboard(deduped);
  console.log("Leaderboard:", leaderboard.map((e) => `${e.repo}(${e.score})`).join(", "));
  await updateReadmeLeaderboard(renderLeaderboardMarkdown(leaderboard));

  await generateSkyline(repos);
}

main().catch((error) => {
  console.error("Fatal error while updating README:", error);
  process.exit(1);
});
