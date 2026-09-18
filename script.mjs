#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

/**
 * @typedef {Object} Subscription
 * @property {boolean} subscribed
 * @property {boolean} ignored
 * @property {string | null} reason
 */

/**
 * @typedef {Object} Issue
 * @property {number} number
 * @property {string} title
 * @property {string | null} body
 */

const TOKEN = process.env.TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const ISSUE_TITLE = "[auto] Repositories I am not watching";
const IGNORE_FILE = "ignore.txt";

if (!TOKEN) {
  console.error("::error::TOKEN is missing.");
  process.exit(1);
}
if (!GITHUB_TOKEN) {
  console.error("::error::GITHUB_TOKEN is missing.");
  process.exit(1);
}
if (!REPO) {
  console.error("::error::GITHUB_REPOSITORY is missing.");
  process.exit(1);
}

/**
 * @param {string} path
 * @param {RequestInit} [opts]
 * @param {string} [token]
 * @returns {Promise<Response>}
 */
async function api(path, opts = {}, token = TOKEN) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return res;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<unknown>} fn
 * @returns {Promise<unknown[]>}
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

async function main() {
  console.log("::group::Setup");
  const login = (await (await api("/user")).json()).login;
  console.log(`Authenticated as ${login}`);
  console.log(`Report issue will be filed in ${REPO}`);
  console.log("::endgroup::");

  console.log("::group::Listing repositories");
  /** @type {string[]} */
  const repos = [];
  for (let page = 1; ; page++) {
    const res = await api(
      `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`
    );
    const data = await res.json();
    const admins = data.filter((r) => r.permissions?.admin);
    repos.push(...admins.map((r) => r.full_name));
    console.log(`Page ${page}: ${data.length} repos, ${admins.length} with admin`);
    if (data.length < 100) break;
  }
  console.log(`Total admin repos: ${repos.length}`);
  console.log("::endgroup::");

  /** @type {Set<string>} */
  let ignored;
  try {
    ignored = new Set(
      readFileSync(IGNORE_FILE, "utf8")
        .split("\n")
        .map((l) => l.replace(/\s*#.*$/, "").trim())
        .filter(Boolean)
    );
  } catch {
    ignored = new Set();
  }
  console.log(`Ignored (${ignored.size}): ${[...ignored].join(", ") || "<none>"}`);

  const targets = repos.filter((r) => !ignored.has(r));
  for (const r of repos) if (ignored.has(r)) console.log(`  skip (ignored): ${r}`);

  console.log("::group::Checking subscriptions");
  /**
   * @param {string} fullName
   * @returns {Promise<string | null>} null if watched, otherwise a description of the unwatched state
   */
  async function check(fullName) {
    const res = await api(`/repos/${fullName}/subscription`);
    if (res.status === 404) {
      console.log(`  not watching: ${fullName} (never subscribed)`);
      return `${fullName} (never subscribed)`;
    }
    /** @type {Subscription} */
    const s = await res.json();
    if (s.subscribed) {
      console.log(`  watching:     ${fullName}`);
      return null;
    }
    console.log(`  not watching: ${fullName} (${s.reason || "unsubscribed"})`);
    return `${fullName} (${s.reason || "unsubscribed"})`;
  }

  /** @type {string[]} */
  const unwatched = (await mapLimit(targets, 10, check)).filter(Boolean);
  console.log(`Checking done. Unwatched: ${unwatched.length} / ${targets.length}`);
  console.log("::endgroup::");

  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    `Automatically generated report of repositories where **${login}** has admin access but is not watching.`,
    "",
    `> Last checked: ${now}`,
    "",
  ];
  if (unwatched.length) {
    lines.push(`## Not watching (${unwatched.length} of ${repos.length})`, "");
    unwatched.forEach((r) => lines.push(`- \`${r}\``));
    lines.push("", "To watch one, open the repo and click **Watch**, or run:", "```bash", "gh api -X PUT repos/OWNER/REPO/subscription -f subscribed=true", "```");
  } else {
    lines.push("All admin repositories are being watched. Nothing to do here.");
  }
  const body = lines.join("\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `# Watch status\nAdmin: ${repos.length}\nNot watching: ${unwatched.length}\n\n${unwatched.map((r) => `- ${r}`).join("\n") || "All watched."}\n`
    );
  }

  console.log("::group::Report");
  /** @type {Issue[]} */
  const issues = await (await api(`/repos/${REPO}/issues?state=open&per_page=100`, {}, GITHUB_TOKEN)).json();
  const existing = issues.find((i) => i.title === ISSUE_TITLE)?.number;

  if (!unwatched.length) {
    if (existing) {
      await api(`/repos/${REPO}/issues/${existing}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }, GITHUB_TOKEN);
      console.log(`Closed issue #${existing}.`);
    } else {
      console.log("No unwatched repos and no open report issue. Nothing to do.");
    }
    console.log("::endgroup::");
    return;
  }

  if (existing) {
    await api(`/repos/${REPO}/issues/${existing}`, { method: "PATCH", body: JSON.stringify({ body }) }, GITHUB_TOKEN);
    console.log(`Updated issue #${existing}.`);
  } else {
    const res = await api(`/repos/${REPO}/issues`, { method: "POST", body: JSON.stringify({ title: ISSUE_TITLE, body }) }, GITHUB_TOKEN);
    console.log(`Created issue #${(await res.json()).number}.`);
  }
  console.log("::endgroup::");
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
