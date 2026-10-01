// CatNews newsroom — writes news.json from first-party sources only.
// Run with:  node build-news.js   (Node 18+, no packages)
//
// No aggregators here. We watch the companies directly:
//   github   → release feeds of their official repos (exact timestamps)
//   hf       → new model uploads on their Hugging Face orgs (exact timestamps)
//   rss      → their own blog / changelog feeds
//   sitemap  → their sitemaps; a URL we've never seen before = a new post
// and write the headline ourselves.
//
// Speed: every item keeps `seenAt` (when we first saw it). If it was published
// after our previous run, `lagMs` = how long it took us to catch it. Later runs
// look the same link up on Hacker News so /our-speed can show who was first.

const fs = require("fs");
const path = require("path");
const SOURCES = require("./sources.js");

const OUT = path.join(__dirname, "news.json");
const UA = { "user-agent": "CatNewsBot/1.0 (+https://catnews.space)" };
const WINDOW_DAYS = 14;
const MAX_ITEMS = 400;

const WATCH = [
  { source: "claude",      type: "sitemap", name: "Anthropic",   url: "https://www.anthropic.com/sitemap.xml", match: /\/news\/[^/]+$/ },
  { source: "claude",      type: "github",  name: "Claude Code", repo: "anthropics/claude-code" },
  { source: "openai",      type: "rss",     name: "OpenAI",      url: "https://openai.com/news/rss.xml" },
  { source: "openai",      type: "github",  name: "Codex CLI",   repo: "openai/codex" },
  { source: "gemini",      type: "rss",     name: "DeepMind",    url: "https://deepmind.google/blog/rss.xml" },
  { source: "gemini",      type: "rss",     name: "Google AI",   url: "https://blog.google/technology/ai/rss/" },
  { source: "gemini",      type: "github",  name: "Gemini CLI",  repo: "google-gemini/gemini-cli" },
  { source: "gemini",      type: "hf",      name: "Google",      author: "google" },
  { source: "deepseek",    type: "hf",      name: "DeepSeek",    author: "deepseek-ai" },
  { source: "deepseek",    type: "sitemap", name: "DeepSeek",    url: "https://api-docs.deepseek.com/sitemap.xml", match: /\/news\/news\d+$/ },
  { source: "grok",        type: "hf",      name: "xAI",         author: "xai-org" },
  { source: "kimi",        type: "hf",      name: "Moonshot AI", author: "moonshotai" },
  // perplexity.ai blocks bots (403), so Perplexity news comes from the community feed only
  { source: "opencode",    type: "github",  name: "OpenCode",    repo: "anomalyco/opencode" },
  { source: "mistral",     type: "hf",      name: "Mistral",     author: "mistralai" },
  { source: "mistral",     type: "sitemap", name: "Mistral",     url: "https://mistral.ai/sitemap-0.xml", match: /mistral\.ai\/news\/[^/]+\/$/ },
  { source: "meta",        type: "hf",      name: "Meta",        author: "meta-llama" },
  { source: "qwen",        type: "hf",      name: "Qwen",        author: "Qwen" },
  { source: "qwen",        type: "rss",     name: "Qwen",        url: "https://qwenlm.github.io/blog/index.xml" },
  { source: "huggingface", type: "rss",     name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { source: "cursor",      type: "rss",     name: "Cursor",      url: "https://cursor.com/changelog/rss.xml" },
  { source: "copilot",     type: "rss",     name: "GitHub",      url: "https://github.blog/changelog/label/copilot/feed/" },
];

/* ---------- tiny helpers (no xml library on purpose) ---------- */

const get = async (url, type = "text") => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res[type]();
};

function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const strip = (html = "") => decode(decode(html)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const clip = (s, n = 220) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
const tag = (xml, name) => (xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")) || [])[1];
const cutoff = () => Date.now() - WINDOW_DAYS * 86400e3;

function meta(html, prop) {
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)`, "i"));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i"));
  return decode((a || b || [])[1] || "");
}

/* ---------- readers: each returns [{ key, title, url, summary, publishedAt, kind }] ---------- */

async function readRss(w) {
  const xml = await get(w.url);
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || [];
  return blocks.map((b) => {
    const link = decode(tag(b, "link") || (b.match(/<link[^>]+href="([^"]+)"/) || [])[1] || "").trim();
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    return {
      key: link,
      title: strip(tag(b, "title")),
      url: link,
      summary: clip(strip(tag(b, "description") || tag(b, "summary") || tag(b, "content"))),
      publishedAt: date ? Date.parse(strip(date)) : null,
      kind: "post",
    };
  });
}

async function readGithub(w) {
  const xml = await get(`https://github.com/${w.repo}/releases.atom`);
  const entries = (xml.match(/<entry>[\s\S]*?<\/entry>/g) || [])
    .filter((b) => !/alpha|beta|-rc|nightly|preview|canary/i.test(strip(tag(b, "title"))))
    .slice(0, 6);
  return entries.map((b) => {
    const version = strip(tag(b, "title")).replace(/^rust-/, "");
    // first few bullet points of the changelog make a decent summary
    const bullets = [...decode(tag(b, "content") || "").matchAll(/<li>([\s\S]*?)<\/li>/g)].slice(0, 2).map((m) => strip(m[1]));
    return {
      key: `${w.repo}@${version}`,
      title: `${w.name} ${version} is out`,
      url: (b.match(/<link[^>]+href="([^"]+)"/) || [])[1],
      summary: clip(bullets.join(" · ") || strip(tag(b, "content")).replace(/^Release\s+\S+\s*/, "")),
      publishedAt: Date.parse(tag(b, "updated")),
      kind: "release",
    };
  });
}

// skip re-uploads and quantized copies; we want actual new models
const VARIANT = /gguf|awq|gptq|-fp8$|-int[48]|mlx|onnx|-bnb|-4bit|-8bit|-quantized/i;

async function readHf(w) {
  const models = await get(`https://huggingface.co/api/models?author=${w.author}&sort=createdAt&direction=-1&limit=25`, "json");
  return models
    .filter((m) => !VARIANT.test(m.id))
    .slice(0, 8)
    .map((m) => {
      const name = m.id.split("/")[1];
      const license = (m.tags || []).find((t) => t.startsWith("license:"));
      const bits = [m.pipeline_tag && m.pipeline_tag.replace(/-/g, " "), license && license.slice(8).toUpperCase() + " license"].filter(Boolean);
      return {
        key: `hf:${m.id}`,
        title: `${w.name} released a new model: ${name}`,
        url: `https://huggingface.co/${m.id}`,
        summary: bits.length ? `Open weights on Hugging Face · ${bits.join(" · ")}` : "Open weights on Hugging Face",
        publishedAt: Date.parse(m.createdAt),
        kind: "model",
      };
    });
}

// sitemaps don't give a reliable publish date, so a URL is "new" the first time we see it.
// We remember every URL each sitemap has ever listed (news.json → sitemapSeen).
// Titles come from the page itself, only fetched for brand-new URLs.
async function readSitemap(w, seenBefore) {
  const xml = await get(w.url);
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    url: decode(tag(m[1], "loc") || "").trim(),
    lastmod: Date.parse(tag(m[1], "lastmod") || "") || 0,
  })).filter((e) => w.match.test(e.url));

  const firstTime = !seenBefore;
  const fresh = firstTime
    ? entries.filter((e) => e.lastmod > cutoff()).sort((a, b) => b.lastmod - a.lastmod).slice(0, 6) // backfill a few dated ones, not counted as "caught"
    : entries.filter((e) => !seenBefore.has(e.url)).slice(0, 8);

  const out = [];
  for (const e of fresh) {
    try {
      const html = await get(e.url);
      const title = meta(html, "og:title") || strip(tag(html, "title"));
      out.push({
        key: e.url,
        title: title.replace(/\s*[|\-–]\s*(Anthropic|Mistral AI|Perplexity|DeepSeek API Docs)\s*$/i, ""),
        url: e.url,
        summary: clip(meta(html, "og:description") || meta(html, "description")),
        // for a brand-new page, lastmod is the moment it went up
        publishedAt: e.lastmod && e.lastmod <= Date.now() ? e.lastmod : null,
        kind: "post",
        sitemapNew: !firstTime,
      });
    } catch (err) {
      console.warn("  title fetch failed:", e.url, err.message);
    }
  }
  out.allUrls = entries.map((e) => e.url);
  return out;
}

/* ---------- hacker news cross-check for /our-speed ---------- */

async function findOnHn(url) {
  const q = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const params = new URLSearchParams({ query: q, restrictSearchableAttributes: "url", tags: "story", hitsPerPage: "5" });
  const { hits } = await get(`https://hn.algolia.com/api/v1/search?${params}`, "json");
  const match = hits.filter((h) => h.url && h.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") === q);
  if (!match.length) return null;
  const first = match.sort((a, b) => a.created_at_i - b.created_at_i)[0];
  return { at: first.created_at_i * 1000, id: first.objectID };
}

/* ---------- main ---------- */

async function main() {
  const runStart = Date.now();
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  const items = new Map((prev?.items || []).map((i) => [i.id, i]));
  const label = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));
  const stats = [];
  const sitemapSeen = { ...(prev?.sitemapSeen || {}) };

  const results = await Promise.allSettled(
    WATCH.map(async (w) => {
      const t0 = Date.now();
      const seen = prev?.sitemapSeen?.[watchId(w)];
      const found =
        w.type === "rss" ? await readRss(w) :
        w.type === "github" ? await readGithub(w) :
        w.type === "hf" ? await readHf(w) :
        await readSitemap(w, seen && new Set(seen));
      return { w, found, ms: Date.now() - t0 };
    })
  );

  let added = 0;
  results.forEach((r, i) => {
    const w = WATCH[i];
    if (r.status === "rejected") {
      console.warn("✗", watchId(w), r.reason.message);
      stats.push({ watch: watchId(w), ok: false });
      return;
    }
    stats.push({ watch: watchId(w), ok: true, ms: r.value.ms });
    if (r.value.found.allUrls) {
      sitemapSeen[watchId(w)] = [...new Set([...(sitemapSeen[watchId(w)] || []), ...r.value.found.allUrls])];
    }

    for (const f of r.value.found) {
      if (!f.title || !f.url) continue;
      if (f.publishedAt && f.publishedAt < cutoff()) continue;
      const id = `${w.source}:${f.key}`;
      if (items.has(id)) continue;

      const seenAt = Date.now();
      const item = {
        id,
        source: w.source,
        sourceLabel: label[w.source],
        from: w.name,
        watch: watchId(w),
        kind: f.kind,
        title: f.title,
        url: f.url,
        summary: f.summary || "",
        publishedAt: f.publishedAt || null,
        seenAt,
      };

      // speed: only count things that appeared since our last run (not backfill)
      if (prev?.lastRunAt) {
        if (f.publishedAt && f.publishedAt >= prev.lastRunAt - 60e3) {
          item.lagMs = Math.max(0, seenAt - f.publishedAt);
        } else if (f.sitemapNew && !f.publishedAt) {
          // we don't know the exact publish time, only that it wasn't there last run
          item.lagMs = seenAt - prev.lastRunAt;
          item.lagIsUpperBound = true;
        }
      }
      if (!item.publishedAt) item.publishedAt = seenAt;

      items.set(id, item);
      added++;
    }
  });

  // look up recently caught items on Hacker News (keep checking for 3 days)
  const toCheck = [...items.values()]
    .filter((i) => i.lagMs != null && !i.hn && Date.now() - i.seenAt < 3 * 86400e3)
    .slice(0, 25);
  for (const item of toCheck) {
    try {
      const hn = await findOnHn(item.url);
      if (hn) item.hn = hn;
    } catch {}
  }

  const list = [...items.values()]
    .filter((i) => i.publishedAt >= cutoff() || i.lagMs != null)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS);

  const out = {
    lastRunAt: runStart,
    runMs: Date.now() - runStart,
    watched: stats.filter((s) => s.ok).map((s) => s.watch),
    sources: stats,
    items: list,
    sitemapSeen,
  };
  // only touch the file when the news changed, so the Action doesn't commit every 5 minutes
  const same = prev && JSON.stringify(prev.items) === JSON.stringify(out.items) && JSON.stringify(prev.sitemapSeen) === JSON.stringify(out.sitemapSeen);
  if (same) return console.log(`no changes (${out.watched.length}/${WATCH.length} sources ok, ${out.runMs}ms)`);
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`news.json: ${list.length} items (${added} new) from ${out.watched.length}/${WATCH.length} sources in ${out.runMs}ms`);
}

function watchId(w) {
  return `${w.type}:${w.repo || w.author || w.url}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
