import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOGIN = process.env.STATS_LOGIN ?? "rolandsusans";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = process.env.STATS_OUT ?? "data/stats.json";
const DAY = 86400e3;

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const dayKey = (d) => d.toISOString().slice(0, 10);

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": `${LOGIN}-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  if (!body.data?.user) throw new Error(`GraphQL returned no user: ${JSON.stringify(body)}`);
  return body.data;
}

const TOTALS = `
  totalCommitContributions
  totalPullRequestContributions
  totalPullRequestReviewContributions
  totalIssueContributions
  restrictedContributionsCount
`;

const PROFILE_QUERY = `
query($login:String!, $cursor:String) {
  user(login:$login) {
    login name avatarUrl url createdAt location
    followers { totalCount }
    repositoriesContributedTo(first:1, contributionTypes:[COMMIT,PULL_REQUEST,ISSUE,REPOSITORY,PULL_REQUEST_REVIEW]) { totalCount }
    repositories(first:100, after:$cursor, ownerAffiliations:[OWNER], isFork:false, orderBy:{field:PUSHED_AT, direction:DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name url description isPrivate isArchived stargazerCount forkCount pushedAt
        primaryLanguage { name color }
        languages(first:16, orderBy:{field:SIZE, direction:DESC}) { edges { size node { name color } } }
      }
    }
  }
}`;

async function fetchProfile() {
  const nodes = [];
  let cursor = null;
  let head = null;
  let repoCount = 0;
  do {
    const { user } = await graphql(PROFILE_QUERY, { login: LOGIN, cursor });
    head ??= user;
    repoCount = user.repositories.totalCount;
    nodes.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (cursor);
  return { head, repos: nodes, repoCount };
}

/** Rolling windows, each with the preceding same-length window so tiles can show a delta. */
async function fetchWindows(days, to) {
  const spec = days.flatMap((n) => [
    { key: `c${n}`, days: n, span: "current", from: new Date(to.getTime() - n * DAY), to },
    {
      key: `p${n}`,
      days: n,
      span: "previous",
      from: new Date(to.getTime() - 2 * n * DAY),
      to: new Date(to.getTime() - n * DAY),
    },
  ]);
  const fields = spec
    .map((s) => `${s.key}: contributionsCollection(from:"${iso(s.from)}", to:"${iso(s.to)}") { ${TOTALS} }`)
    .join("\n");
  const { user } = await graphql(`query($login:String!) { user(login:$login) { ${fields} } }`, { login: LOGIN });
  return days.map((n) => ({
    days: n,
    current: pickTotals(user[`c${n}`]),
    previous: pickTotals(user[`p${n}`]),
  }));
}

const pickTotals = (c) => ({
  commits: c.totalCommitContributions,
  pullRequests: c.totalPullRequestContributions,
  reviews: c.totalPullRequestReviewContributions,
  issues: c.totalIssueContributions,
});

/** contributionsCollection caps at one year per range, so query year by year. */
async function fetchYears(firstYear, lastYear) {
  const wanted = [];
  for (let y = firstYear; y <= lastYear; y++) wanted.push(y);
  const out = [];
  for (let i = 0; i < wanted.length; i += 4) {
    const chunk = wanted.slice(i, i + 4);
    const fields = chunk
      .map(
        (y) => `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z") {
          ${TOTALS}
          contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
        }`
      )
      .join("\n");
    const { user } = await graphql(`query($login:String!) { user(login:$login) { ${fields} } }`, { login: LOGIN });
    for (const year of chunk) {
      const c = user[`y${year}`];
      out.push({
        year,
        contributions: c.contributionCalendar.totalContributions,
        commits: c.totalCommitContributions,
        pullRequests: c.totalPullRequestContributions,
        reviews: c.totalPullRequestReviewContributions,
        issues: c.totalIssueContributions,
        restricted: c.restrictedContributionsCount,
        days: c.contributionCalendar.weeks
          .flatMap((w) => w.contributionDays)
          .filter((d) => d.date.startsWith(`${year}-`)),
      });
    }
  }
  return out;
}

/** Dense daily series over [account creation, today]: a start date plus a count per day. */
function densify(years, from, to) {
  const counts = new Map();
  for (const y of years) for (const d of y.days) counts.set(d.date, d.contributionCount);
  const start = new Date(`${dayKey(from)}T00:00:00Z`);
  const end = new Date(`${dayKey(to)}T00:00:00Z`);
  const series = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    series.push(counts.get(dayKey(new Date(t))) ?? 0);
  }
  return { start: dayKey(start), counts: series };
}

function streaks(counts) {
  let best = 0;
  let run = 0;
  for (const n of counts) {
    run = n > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let current = 0;
  for (let i = counts.length - 1; i >= 0; i--) {
    if (counts[i] === 0) {
      // an idle today has not broken the run yet
      if (i === counts.length - 1) continue;
      break;
    }
    current++;
  }
  return { current, best };
}

function aggregateLanguages(repos) {
  const byName = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const entry = byName.get(node.name) ?? { name: node.name, color: node.color, bytes: 0, repos: 0 };
      entry.bytes += size;
      entry.repos += 1;
      byName.set(node.name, entry);
    }
  }
  return [...byName.values()].sort((a, b) => b.bytes - a.bytes);
}

const now = new Date();
const { head, repos, repoCount } = await fetchProfile();
const years = await fetchYears(new Date(head.createdAt).getUTCFullYear(), now.getUTCFullYear());
const calendar = densify(years, new Date(head.createdAt), now);
const windows = await fetchWindows([30, 90, 365], now);

const stats = {
  generatedAt: iso(now),
  user: {
    login: head.login,
    name: head.name,
    avatarUrl: head.avatarUrl,
    url: head.url,
    createdAt: head.createdAt,
    location: head.location,
    followers: head.followers.totalCount,
    contributedTo: head.repositoriesContributedTo.totalCount,
    ownedRepos: repoCount,
  },
  totals: {
    stars: repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    forks: repos.reduce((sum, r) => sum + r.forkCount, 0),
  },
  streaks: streaks(calendar.counts),
  windows,
  calendar,
  years: years.map(({ days, ...rest }) => rest),
  languages: aggregateLanguages(repos),
  repos: repos.map((r) => ({
    name: r.name,
    url: r.url,
    description: r.description,
    private: r.isPrivate,
    archived: r.isArchived,
    stars: r.stargazerCount,
    forks: r.forkCount,
    pushedAt: r.pushedAt,
    language: r.primaryLanguage?.name ?? null,
    languageColor: r.primaryLanguage?.color ?? null,
  })),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(stats)}\n`);

console.log(
  [
    `wrote ${OUT}`,
    `${(JSON.stringify(stats).length / 1024).toFixed(1)} KB`,
    `days ${calendar.counts.length} from ${calendar.start}`,
    `repos ${repos.length}/${repoCount}`,
    `languages ${stats.languages.length}`,
    `years ${years.length}`,
    `windows ${windows.length}`,
    `streak ${stats.streaks.current}/${stats.streaks.best}`,
  ].join(" · ")
);
