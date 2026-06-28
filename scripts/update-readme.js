const fs = require("fs");
const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// 👇 Change this to your organization name
const ORG = "anarnapr";

async function run() {
  const { data: events } = await octokit.request("GET /orgs/{org}/events", {
    org: ORG,
    per_page: 10,
  });

  let markdown = "";

  for (const event of events) {
    switch (event.type) {
      case "PushEvent": {
        const commitCount = event.payload?.commits?.length ?? 0;

        markdown += `- 🚀 **${event.actor?.login ?? "Unknown"}** pushed ${commitCount} commit(s) to \`${event.repo?.name ?? "Unknown Repo"}\`\n`;
        break;
      }

      case "IssuesEvent": {
        markdown += `- 🐛 **${event.actor?.login ?? "Unknown"}** ${event.payload?.action ?? "updated"} issue #${event.payload?.issue?.number ?? "?"} in \`${event.repo?.name ?? "Unknown Repo"}\`\n`;
        break;
      }

      case "PullRequestEvent": {
        markdown += `- ✅ **${event.actor?.login ?? "Unknown"}** ${event.payload?.action ?? "updated"} PR #${event.payload?.pull_request?.number ?? "?"} in \`${event.repo?.name ?? "Unknown Repo"}\`\n`;
        break;
      }

      case "ReleaseEvent": {
        markdown += `- 📦 Released **${event.payload?.release?.tag_name ?? "Unknown"}** in \`${event.repo?.name ?? "Unknown Repo"}\`\n`;
        break;
      }

      case "CreateEvent": {
        markdown += `- ✨ **${event.actor?.login ?? "Unknown"}** created ${event.payload?.ref_type ?? "resource"} in \`${event.repo?.name ?? "Unknown Repo"}\`\n`;
        break;
      }

      case "DeleteEvent": {
        markdown += `- 🗑️ **${event.actor?.login ?? "Unknown"}** deleted ${event.payload?.ref_type ?? "resource"} in \`${event.repo?.name ?? "Unknown Repo"}\`\n`;
        break;
      }

      default:
        break;
    }
  }

  if (markdown.trim() === "") {
    markdown = "_No recent activity found._";
  }

  const readmePath = "profile/README.md";

  const readme = fs.readFileSync(readmePath, "utf8");

  const updated = readme.replace(
    /<!--START_ACTIVITY-->[\s\S]*<!--END_ACTIVITY-->/,
    `<!--START_ACTIVITY-->\n${markdown}\n<!--END_ACTIVITY-->`
  );

  fs.writeFileSync(readmePath, updated);

  console.log("README updated successfully.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
