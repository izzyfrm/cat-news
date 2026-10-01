// CatNews RSS builder — writes rss.xml with our first-party stories (news.json)
// plus the biggest community stories from Hacker News.
// Run it with:  node build-rss.js   (Node 18+, no packages needed)
//
// A newsletter service (Buttondown, Mailchimp, etc.) can watch rss.xml and
// email subscribers whenever a new item shows up. Only stories that pass
// MIN_POINTS get in, so people get the big news, not every small post.

const fs = require("fs");
const path = require("path");
const SOURCES = require("./sources.js");

const API = "https://hn.algolia.com/api/v1/search_by_date";
const SITE = "https://catnews.space";
const WINDOW_HOURS = 48;
const MIN_POINTS = 40;
const MAX_ITEMS = 30;

async function fetchSource(src) {
  const since = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600;
  const hits = [];
  for (const term of src.terms) {
    const params = new URLSearchParams({
      query: term,
      tags: "story",
      numericFilters: `created_at_i>${since},points>=${MIN_POINTS}`,
      hitsPerPage: "50",
    });
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) throw new Error(`${src.label}: HTTP ${res.status}`);
    hits.push(...(await res.json()).hits);
  }
  return hits.filter((h) => h.title && matches(h.title, src.terms));
}

// same check the site uses: the term has to be in the headline itself
function matches(title, terms) {
  const t = title.toLowerCase();
  return terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
}

function xml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

async function main() {
  const stories = new Map();
  const results = await Promise.allSettled(SOURCES.map(fetchSource));

  results.forEach((res, i) => {
    if (res.status === "rejected") return console.warn("skipped", res.reason.message);
    for (const hit of res.value) {
      const s = stories.get(hit.objectID) || { hit, tags: new Set() };
      s.tags.add(SOURCES[i].label);
      stories.set(hit.objectID, s);
    }
  });

  if (results.every((r) => r.status === "rejected")) {
    // keep the old feed rather than publishing an empty one
    console.error("All sources failed — rss.xml left unchanged.");
    process.exit(1);
  }

  // first-party items from build-news.js (releases, new models, official posts)
  const newsFile = path.join(__dirname, "news.json");
  const official = fs.existsSync(newsFile)
    ? JSON.parse(fs.readFileSync(newsFile, "utf8")).items.filter((i) => Date.now() - i.publishedAt < WINDOW_HOURS * 3600e3)
    : [];
  const officialXml = official.map((i) => ({
    time: i.publishedAt,
    xml: `    <item>
      <title>${xml(i.title)}</title>
      <link>${xml(i.url)}</link>
      <guid isPermaLink="false">catnews-${xml(i.id)}</guid>
      <pubDate>${new Date(i.publishedAt).toUTCString()}</pubDate>
      <category>${xml(i.sourceLabel)}</category>
      <description>${xml(`<p><b>${i.sourceLabel}</b> · official ${i.kind}</p>${i.summary ? `<p>${i.summary}</p>` : ""}<p><a href="${i.url}">Read it →</a></p>`)}</description>
    </item>`,
  }));

  const community = [...stories.values()]
    .map(({ hit, tags }) => {
      const hn = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      const link = hit.url || hn;
      const labels = [...tags].join(", ");
      return `    <item>
      <title>${xml(hit.title)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="false">catnews-${hit.objectID}</guid>
      <pubDate>${new Date(hit.created_at_i * 1000).toUTCString()}</pubDate>
${[...tags].map((t) => `      <category>${xml(t)}</category>`).join("\n")}
      <description>${xml(`<p><b>${labels}</b> · ${hit.points} points · <a href="${hn}">${hit.num_comments || 0} comments on Hacker News</a></p><p><a href="${link}">Read the story →</a></p>`)}</description>
    </item>`;
    }).map((x, i) => ({ time: [...stories.values()][i].hit.created_at_i * 1000, xml: x }));

  const items = [...officialXml, ...community]
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_ITEMS)
    .map((i) => i.xml);

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>CatNews</title>
    <link>${SITE}</link>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>
    <description>The biggest AI news for developers — Claude, OpenAI, Gemini, DeepSeek, Grok, Kimi, Perplexity, OpenCode and more.</description>
    <language>en</language>
    <image>
      <url>${SITE}/logo.jpg</url>
      <title>CatNews</title>
      <link>${SITE}</link>
    </image>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>10</ttl>
${items.join("\n")}
  </channel>
</rss>
`;

  // skip the write when only lastBuildDate would change
  const file = path.join(__dirname, "rss.xml");
  const noDate = (s) => s.replace(/<lastBuildDate>.*<\/lastBuildDate>/, "");
  if (fs.existsSync(file) && noDate(fs.readFileSync(file, "utf8")) === noDate(feed)) return console.log("rss.xml unchanged");
  fs.writeFileSync(file, feed);
  console.log(`rss.xml written — ${official.length} official + ${community.length} community (≥${MIN_POINTS} pts), last ${WINDOW_HOURS}h`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
