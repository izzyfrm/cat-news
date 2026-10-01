// CatNews newsroom engine — shared by build-news.js (Node) and worker/ (Cloudflare, every minute).
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
//
// Cheap when nothing changed: each source is fetched with If-None-Match, and
// sources without ETags are fingerprinted, so an unchanged feed is never parsed.

const SOURCES = require("./sources.js");

const UA = { "user-agent": "CatNewsBot/1.0 (+https://catnews.space)" };
const WINDOW_DAYS = 14;
const MAX_ITEMS = 400;
const HN_CHECKS_PER_RUN = 8;

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

const watchId = (w) => `${w.type}:${w.repo || w.author || w.url}`;
// with a GitHub token we use the REST API (5,000 req/h, and 304s are free);
// without one, the public releases.atom feed (shared, often rate-limited from Cloudflare)
let githubToken = null;
const feedUrl = (w) =>
  w.type === "github"
    ? (githubToken ? `https://api.github.com/repos/${w.repo}/releases?per_page=10` : `https://github.com/${w.repo}/releases.atom`) :
  w.type === "hf" ? `https://huggingface.co/api/models?author=${w.author}&sort=createdAt&direction=-1&limit=25` :
  w.url;

/* ---------- tiny helpers (no xml library on purpose) ---------- */

async function get(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// fast string fingerprint (FNV-1a) for feeds that don't send ETags
function fingerprint(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

// fetch a watched feed; returns null when it hasn't changed since last time
async function getIfChanged(w, cache) {
  const url = feedUrl(w);
  const prev = cache[url] || {};
  const headers = { ...UA };
  if (githubToken && url.startsWith("https://api.github.com/")) {
    headers.authorization = `Bearer ${githubToken}`;
    headers.accept = "application/vnd.github+json";
  }
  if (prev.etag) headers["if-none-match"] = prev.etag;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  let body = await res.text();
  // feeds list newest first, so only the top matters (OpenAI's is ~750kb)
  if (w.type === "rss") body = body.slice(0, 60000);
  const etag = res.headers.get("etag");
  const fp = etag ? null : fingerprint(body);
  if (!etag && prev.fp === fp) return null;
  cache[url] = etag ? { etag } : { fp };
  return body;
}

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

/* ---------- readers: each turns a feed body into [{ key, title, url, summary, publishedAt, kind }] ---------- */

function readRss(w, xml) {
  const blocks = (xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || []).slice(0, 20);
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

function readGithubApi(w, body) {
  return JSON.parse(body)
    .filter((r) => !r.draft && !r.prerelease && !/alpha|beta|-rc|nightly|preview|canary/i.test(r.tag_name))
    .slice(0, 6)
    .map((r) => {
      const version = (r.name || r.tag_name).trim().replace(/^rust-/, ""); // same as the atom title
      // first two "- " bullets of the markdown changelog, links flattened
      const bullets = (r.body || "").split("\n").filter((l) => /^\s*[-*] /.test(l)).slice(0, 2)
        .map((l) => l.replace(/^\s*[-*] /, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").trim());
      return {
        key: `${w.repo}@${version}`,
        title: `${w.name} ${version} is out`,
        url: r.html_url,
        summary: clip(bullets.join(" · ") || strip(r.body || "")),
        publishedAt: Date.parse(r.published_at || r.created_at),
        kind: "release",
      };
    });
}

function readGithub(w, xml) {
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

function readHf(w, body) {
  return JSON.parse(body)
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
// We remember every URL each sitemap has ever listed (sitemapSeen).
// Titles come from the page itself, only fetched for brand-new URLs.
async function readSitemap(w, xml, seenBefore) {
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    url: decode(tag(m[1], "loc") || "").trim(),
    lastmod: Date.parse(tag(m[1], "lastmod") || "") || 0,
  })).filter((e) => w.match.test(e.url));

  const firstTime = !seenBefore;
  const fresh = firstTime
    ? entries.filter((e) => e.lastmod > cutoff()).sort((a, b) => b.lastmod - a.lastmod).slice(0, 6) // backfill a few dated ones, not counted as "caught"
    : entries.filter((e) => !seenBefore.has(e.url)).slice(0, 5);

  const out = [];
  for (const e of fresh) {
    try {
      const html = (await get(e.url)).slice(0, 40000); // <head> is all we need
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
  const { hits } = JSON.parse(await get(`https://hn.algolia.com/api/v1/search?${params}`));
  const match = hits.filter((h) => h.url && h.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") === q);
  if (!match.length) return null;
  const first = match.sort((a, b) => a.created_at_i - b.created_at_i)[0];
  return { at: first.created_at_i * 1000, id: first.objectID };
}

/* ---------- one newsroom run ---------- */

// prev  = last saved state (news.json shape) or null
// cache = { [feedUrl]: { etag } | { fp } }, mutated in place
// opts  = { githubToken }
// returns { out, added, changed }
async function runNewsroom(prev, cache = {}, opts = {}) {
  githubToken = opts.githubToken || null;
  const runStart = Date.now();
  const items = new Map((prev?.items || []).map((i) => [i.id, i]));
  const label = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));
  const stats = [];
  const sitemapSeen = { ...(prev?.sitemapSeen || {}) };
  let changed = false;

  const results = await Promise.allSettled(
    WATCH.map(async (w) => {
      const t0 = Date.now();
      const body = await getIfChanged(w, cache);
      if (body == null) return { found: [], ms: Date.now() - t0, unchanged: true };
      const seen = sitemapSeen[watchId(w)];
      const found =
        w.type === "rss" ? readRss(w, body) :
        w.type === "github" ? (githubToken ? readGithubApi(w, body) : readGithub(w, body)) :
        w.type === "hf" ? readHf(w, body) :
        await readSitemap(w, body, seen && new Set(seen));
      return { found, ms: Date.now() - t0 };
    })
  );

  let added = 0;
  results.forEach((r, i) => {
    const w = WATCH[i];
    if (r.status === "rejected") {
      console.warn("✗", watchId(w), r.reason.message);
      stats.push({ watch: watchId(w), ok: false, error: String(r.reason?.message || r.reason).slice(0, 120) });
      return;
    }
    stats.push({ watch: watchId(w), ok: true, ms: r.value.ms });
    if (r.value.found.allUrls) {
      const merged = [...new Set([...(sitemapSeen[watchId(w)] || []), ...r.value.found.allUrls])];
      if (merged.length !== (sitemapSeen[watchId(w)] || []).length) changed = true;
      sitemapSeen[watchId(w)] = merged;
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
      changed = true;
    }
  });

  // look up recently caught items on Hacker News (keep checking for 3 days)
  const toCheck = [...items.values()]
    .filter((i) => i.lagMs != null && !i.hn && Date.now() - i.seenAt < 3 * 86400e3)
    .sort((a, b) => (a.hnCheckedAt || 0) - (b.hnCheckedAt || 0))
    .slice(0, HN_CHECKS_PER_RUN);
  await Promise.all(toCheck.map(async (item) => {
    try {
      const hn = await findOnHn(item.url);
      item.hnCheckedAt = Date.now();
      if (hn) { item.hn = hn; changed = true; }
    } catch {}
  }));

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
  return { out, added, changed };
}

module.exports = { WATCH, runNewsroom, watchId };
