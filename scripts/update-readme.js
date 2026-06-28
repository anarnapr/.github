const fs = require("fs");
const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const ORG = "anarnapr";

const pushMessages = [
  (u, r) => `${u} shipped some fresh code to \`${r}\`.`,
  (u, r) => `${u} gave \`${r}\` another update.`,
  (u, r) => `${u} has been cooking in \`${r}\`.`,
  (u, r) => `${u} touched \`${r}\`. Hopefully for the better.`,
  (u, r) => `${u} kept \`${r}\` alive with new code.`,
];

const issueMessages = [
  (u, r, n) => `${u} opened Issue #${n} in \`${r}\`.`,
  (u, r, n) => `${u} found something suspicious in \`${r}\` (Issue #${n}).`,
  (u, r, n) => `${u} added another mystery to \`${r}\` (Issue #${n}).`,
];

const prMessages = [
  (u, r, n) => `${u} opened PR #${n} for \`${r}\`.`,
  (u, r, n) => `${u} thinks PR #${n} is ready in \`${r}\`.`,
  (u, r, n) => `${u} asked GitHub nicely to merge PR #${n}.`,
];

const releaseMessages = [
  (r, tag) => `A new release (${tag}) landed in \`${r}\`.`,
  (r, tag) => `\`${r}\` just got released (${tag}).`,
];

function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function run() {
  const { data: events } = await octokit.request(
    "GET /orgs/{org}/events",
    {
      org: ORG,
      per_page: 20,
    }
  );

  let lines = [];

  for (const event of events) {
    const repo = event.repo?.name ?? "";

    // Ignore profile repo
    if (repo === `${ORG}/.github`) continue;

    switch (event.type) {
      case "PushEvent": {
        const commits = event.payload?.commits ?? [];

        if (commits.length === 0) continue;

        lines.push(
          `- ${random(pushMessages)(
            event.actor.login,
            repo
          )}`
        );
        break;
      }

      case "IssuesEvent": {
        lines.push(
          `- ${random(issueMessages)(
            event.actor.login,
            repo,
            event.payload.issue.number
          )}`
        );
        break;
      }

      case "PullRequestEvent": {
        lines.push(
          `- ${random(prMessages)(
            event.actor.login,
            repo,
            event.payload.pull_request.number
          )}`
        );
        break;
      }

      case "ReleaseEvent": {
        lines.push(
          `- ${random(releaseMessages)(
            repo,
            event.payload.release.tag_name
          )}`
        );
        break;
      }
    }

    if (lines.length >= 8) break;
  }

  if (lines.length === 0) {
    lines.push("- Everyone is suspiciously quiet right now...");
  }

  const readmePath = "profile/README.md";
  const readme = fs.readFileSync(readmePath, "utf8");

  const updated = readme.replace(
    /<!--START_ACTIVITY-->[\s\S]*<!--END_ACTIVITY-->/,
    `<!--START_ACTIVITY-->\n${lines.join("\n")}\n<!--END_ACTIVITY-->`
  );

  fs.writeFileSync(readmePath, updated);
  console.log("README updated.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
