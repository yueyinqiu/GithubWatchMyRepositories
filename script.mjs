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
const REPO = process.env.GITHUB_REPOSITORY;
const ISSUE_TITLE = "[auto] Repositories I am not watching";
const IGNORE_FILE = "ignore.txt";

if (!TOKEN || !REPO) {
  console.error("::error::TOKEN and GITHUB_REPOSITORY are required.");
  process.exit(1);
}

/**
 * @param {string} path
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>}
 */
async function api(path, opts = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    },
  });
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

const login = (await (await api("/user")).json()).login;

/** @type {string[]} */
const repos = [];
for (let page = 1; ; page++) {
  const res = await api(
    `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`
  );
  const data = await res.json();
  for (const r of data) if (r.permissions?.admin) repos.push(r.full_name);
  if (data.length < 100) break;
}

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

const targets = repos.filter((r) => !ignored.has(r));

/**
 * @param {string} fullName
 * @returns {Promise<string | null>} null if watched, otherwise a description of the unwatched state
 */
async function check(fullName) {
  const res = await api(`/repos/${fullName}/subscription`);
  if (res.status === 404) return `${fullName} (never subscribed)`;
  /** @type {Subscription} */
  const s = await res.json();
  return s.subscribed ? null : `${fullName} (${s.reason || "unsubscribed"})`;
}

/** @type {string[]} */
const unwatched = (await mapLimit(targets, 10, check)).filter(Boolean);

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

writeFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  `# Watch status\nAdmin: ${repos.length}\nNot watching: ${unwatched.length}\n\n${unwatched.map((r) => `- ${r}`).join("\n") || "All watched."}\n`
);

/** @type {Issue[]} */
const issues = await (await api(`/repos/${REPO}/issues?state=open&per_page=100`)).json();
const existing = issues.find((i) => i.title === ISSUE_TITLE)?.number;

if (!unwatched.length) {
  if (existing) {
    await api(`/repos/${REPO}/issues/${existing}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    console.log(`Closed issue #${existing}.`);
  }
  process.exit(0);
}

if (existing) {
  await api(`/repos/${REPO}/issues/${existing}`, { method: "PATCH", body: JSON.stringify({ body }) });
  console.log(`Updated issue #${existing}.`);
} else {
  const res = await api(`/repos/${REPO}/issues`, { method: "POST", body: JSON.stringify({ title: ISSUE_TITLE, body }) });
  console.log(`Created issue #${(await res.json()).number}.`);
}
