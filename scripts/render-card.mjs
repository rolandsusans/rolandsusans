import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const IN = process.env.STATS_IN ?? "data/stats.json";
const OUT_DIR = process.env.CARD_DIR ?? "assets";
const DASHBOARD = process.env.DASHBOARD_URL ?? "";

const THEMES = {
  dark: {
    surface: "#0d1117",
    border: "#30363d",
    ink: "#e6edf3",
    ink2: "#9198a1",
    muted: "#6e7681",
    accent: "#22d3ee",
    // validated ordinal ramp on #0d1117
    heat: ["#1b222c", "#0e6d80", "#0e9cb5", "#22d3ee", "#7ce7f7"],
  },
  light: {
    surface: "#ffffff",
    border: "#d1d9e0",
    ink: "#1f2328",
    ink2: "#59636e",
    muted: "#818b98",
    accent: "#0e7490",
    // validated ordinal ramp on #ffffff
    heat: ["#eaeef2", "#0bc0da", "#0e8ba3", "#0e6d80", "#0b4a58"],
  },
};

const W = 860;
const H = 364;
const PAD = 24;
const WEEKS = 52;
// the grid spans ~80% of the card, centred on its own band under the hero figure
const GAP = 2.5;
const STEP = (0.8 * (W - PAD * 2)) / WEEKS;
const CELL = STEP - GAP;

const nf = new Intl.NumberFormat("en-US");
const fmt = (n) => nf.format(n);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function buckets(counts) {
  const active = counts.filter((n) => n > 0).sort((a, b) => a - b);
  if (!active.length) return [1, 2, 3, 4];
  const q = (p) => active[Math.min(active.length - 1, Math.floor(active.length * p))];
  const raw = [1, q(0.25), q(0.5), q(0.75)];
  return raw.map((v, i) => Math.max(v, i === 0 ? 1 : raw[i - 1] + 1));
}
const levelOf = (n, th) => (n <= 0 ? 0 : n < th[1] ? 1 : n < th[2] ? 2 : n < th[3] ? 3 : 4);

function card(stats, theme) {
  const t = THEMES[theme];
  const counts = stats.calendar.counts;
  const days = counts.slice(-WEEKS * 7);
  const th = buckets(days);
  const yearTotal = counts.slice(-365).reduce((a, b) => a + b, 0);
  const year = stats.years.at(-1);

  const pairs = [
    ["Commits", fmt(year.commits)],
    ["Pull requests", fmt(year.pullRequests)],
    ["Reviews", fmt(year.reviews)],
    ["Repositories", fmt(stats.user.ownedRepos)],
    ["Best streak", `${stats.streaks.best} days`],
  ];

  const gridW = WEEKS * STEP - GAP;
  const gridX = PAD + (W - PAD * 2 - gridW) / 2;
  const gridY = 156;
  const gridBottom = gridY + 7 * STEP - GAP;

  // the last cell is today, so pad the first partial week and fill weekday rows top to bottom
  const startOffset = (7 - (days.length % 7)) % 7;
  const cells = days
    .map((n, i) => {
      const slot = i + startOffset;
      const x = gridX + Math.floor(slot / 7) * STEP;
      const y = gridY + (slot % 7) * STEP;
      return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${t.heat[levelOf(n, th)]}"/>`;
    })
    .join("");

  // the whole "less [swatches] more" group is right-aligned inside the grid so nothing overflows
  const legendY = gridBottom + 14;
  const moreX = gridX + gridW;
  const legendW = t.heat.length * 14 - 4;
  const legendX = moreX - 34 - legendW;
  const legend = t.heat
    .map((c, i) => `<rect x="${legendX + i * 14}" y="${legendY}" width="10" height="10" rx="2" fill="${c}"/>`)
    .join("");

  const ruleY = 288;
  const colW = (W - PAD * 2) / pairs.length;
  const statCols = pairs
    .map(([label, value], i) => {
      const x = PAD + i * colW;
      return `<text x="${x}" y="${ruleY + 32}" class="v">${esc(value)}</text><text x="${x}" y="${ruleY + 50}" class="l">${esc(label)}</text>`;
    })
    .join("");

  const summary = `GitHub stats for ${stats.user.name ?? stats.user.login}: ${fmt(yearTotal)} contributions in the last year, ${fmt(year.commits)} commits, ${fmt(year.pullRequests)} pull requests, ${fmt(year.reviews)} reviews, ${fmt(stats.user.ownedRepos)} repositories, best streak ${stats.streaks.best} days.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .name { font-size: 17px; font-weight: 600; fill: ${t.ink}; }
    .hero { font-size: 46px; font-weight: 600; fill: ${t.ink}; }
    .heroL { font-size: 12px; fill: ${t.ink2}; }
    .v { font-size: 18px; font-weight: 600; fill: ${t.ink}; }
    .l { font-size: 11px; fill: ${t.muted}; }
    .cta { font-size: 12px; font-weight: 600; fill: ${t.accent}; }
    .cap { font-size: 11px; fill: ${t.muted}; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${t.surface}" stroke="${t.border}"/>

  <text x="${PAD}" y="38" class="name">${esc(stats.user.name ?? stats.user.login)}</text>
  <text x="${W - PAD}" y="38" class="cta" text-anchor="end">Open the interactive dashboard &#8594;</text>

  <text x="${PAD}" y="104" class="hero">${fmt(yearTotal)}</text>
  <text x="${PAD}" y="126" class="heroL">contributions in the last year</text>

  <text x="${gridX}" y="${gridY - 10}" class="cap">last ${WEEKS} weeks</text>
  ${cells}
  ${legend}
  <text x="${legendX - 6}" y="${legendY + 9}" class="cap" text-anchor="end">less</text>
  <text x="${moreX}" y="${legendY + 9}" class="cap" text-anchor="end">more</text>

  <line x1="${PAD}" y1="${ruleY}" x2="${W - PAD}" y2="${ruleY}" stroke="${t.border}"/>
  ${statCols}
</svg>
`;
}

const stats = JSON.parse(await readFile(IN, "utf8"));
await mkdir(dirname(`${OUT_DIR}/x`), { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const path = `${OUT_DIR}/card-${theme}.svg`;
  await writeFile(path, card(stats, theme));
  console.log(`wrote ${path}`);
}
if (DASHBOARD) console.log(`dashboard: ${DASHBOARD}`);
