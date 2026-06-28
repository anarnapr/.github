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

const MAX_FEED_ITEMS = 10;
const PER_REPO_FETCH_LIMIT = 5; // how many of each event type to pull per repo
const REPO_CONCURRENCY = 4; // how many repos to process in parallel
const MIN_REMAINING_RATE_LIMIT = 100; // safety floor; stop fetching more if we dip below this

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

function renderActivityMarkdown(events) {
  if (events.length === 0) {
    return "Everyone is suspiciously quiet right now...";
  }

  return events
    .map((event) => {
      const funText = generateFunText(event);
      return `* [${funText}](${event.url})`;
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
}

main().catch((error) => {
  console.error("Fatal error while updating README:", error);
  process.exit(1);
});
