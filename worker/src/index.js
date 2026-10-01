// CatNews newsroom on Cloudflare.
//
// Every minute a cron trigger asks the Newsroom Durable Object to check every
// official source (newsroom.js). The Durable Object keeps the state, so each
// run sees exactly what the last one saved. That consistency matters for the
// catch times on /our-speed.
//
//   GET /news.json  → the same shape the site used to read from the repo
//   GET /health     → when the last run happened and how long it took

import { DurableObject } from "cloudflare:workers";
import newsroom from "../../newsroom.js";

const { runNewsroom } = newsroom;
const SEED_URL = "https://catnews.space/news.json"; // first run picks up the history from the repo

export class Newsroom extends DurableObject {
  async run() {
    const storage = this.ctx.storage;
    let prev = await storage.get("news");
    if (!prev) {
      try {
        prev = await (await fetch(SEED_URL)).json();
      } catch {
        prev = null;
      }
    }
    const cache = (await storage.get("cache")) || {};
    const { out, added } = await runNewsroom(prev, cache, { githubToken: this.env.GITHUB_TOKEN });
    // lastRunAt is saved every run: the next run uses it to time new stories
    await storage.put({ news: out, cache });
    return { added, items: out.items.length, ms: out.runMs, ok: out.watched.length };
  }

  async news() {
    return (await this.ctx.storage.get("news")) || null;
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

export default {
  async scheduled(controller, env, ctx) {
    const stub = env.NEWSROOM.getByName("main");
    ctx.waitUntil(stub.run().then((r) => console.log("run", JSON.stringify(r))));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    if (url.pathname === "/news.json" || url.pathname === "/health") {
      // short edge cache so a burst of visitors doesn't wake the Durable Object each time
      const cache = caches.default;
      const key = new Request(url.origin + url.pathname);
      let res = await cache.match(key);
      if (res) return res;

      const news = await env.NEWSROOM.getByName("main").news();
      if (!news) return new Response("Newsroom hasn't run yet", { status: 503, headers: CORS });

      const body = url.pathname === "/health"
        ? { lastRunAt: news.lastRunAt, runMs: news.runMs, sourcesOk: news.watched.length, sources: news.sources.length, items: news.items.length }
        : { ...news, sitemapSeen: undefined }; // the site doesn't need the sitemap memory

      res = new Response(JSON.stringify(body), {
        headers: { ...CORS, "content-type": "application/json", "cache-control": "public, max-age=20" },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    return new Response("CatNews newsroom · GET /news.json", { headers: CORS });
  },
};
