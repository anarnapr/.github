const fs = require("fs");
const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const ORG = "anarnapr";

async function run() {

  const events = await octokit.request(
    "GET /orgs/{org}/events",
    {
      org: ORG,
      per_page: 10
    }
  );

  let markdown = "";

  for (const event of events.data) {

    switch (event.type) {

      case "PushEvent":
        markdown += `- 🚀 **${event.actor.login}** pushed ${event.payload.commits.length} commit(s) to \`${event.repo.name}\`\n`;
        break;

      case "IssuesEvent":
        markdown += `- 🐛 **${event.actor.login}** ${event.payload.action} issue #${event.payload.issue.number} in \`${event.repo.name}\`\n`;
        break;

      case "PullRequestEvent":
        markdown += `- ✅ **${event.actor.login}** ${event.payload.action} PR #${event.payload.pull_request.number} in \`${event.repo.name}\`\n`;
        break;

      case "ReleaseEvent":
        markdown += `- 📦 Released **${event.payload.release.tag_name}** in \`${event.repo.name}\`\n`;
        break;
    }

  }

  const readme = fs.readFileSync("profile/README.md", "utf8");

  const updated = readme.replace(
    /<!--START_ACTIVITY-->[\s\S]*<!--END_ACTIVITY-->/,
    `<!--START_ACTIVITY-->\n${markdown}\n<!--END_ACTIVITY-->`
  );

  fs.writeFileSync("profile/README.md", updated);
}

run();
