// CatNews newsroom, local version — writes news.json using the shared engine in newsroom.js.
// Run with:  node build-news.js   (Node 18+, no packages)
//
// In production the same engine runs every minute on Cloudflare (see worker/),
// which is what makes CatNews fast. This script is for testing and backups.

const fs = require("fs");
const path = require("path");
const { WATCH, runNewsroom } = require("./newsroom.js");

const OUT = path.join(__dirname, "news.json");

async function main() {
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  const { out, added, changed } = await runNewsroom(prev);
  if (prev && !changed) return console.log(`no changes (${out.watched.length}/${WATCH.length} sources ok, ${out.runMs}ms)`);
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`news.json: ${out.items.length} items (${added} new) from ${out.watched.length}/${WATCH.length} sources in ${out.runMs}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
