# Friday Stairs — Newsletter Brain

AI content system that drafts Beehiiv-ready newsletter sections in **Friday Stairs'** voice — the free Friday 7am stair workout on the Tampa Riverwalk.

## What it does

- **Voice "brain"** — RAG over your Instagram + website + pasted samples to draft in your tone.
- **Fitness news scanner** — pulls trend stories from Outside, NYT Well, Men's/Women's Health, Runner's World, SELF, r/fitness, Tampa Bay Times.
- **Recipe creator** — scrapes curated + fitness recipe sites, supports web search by ingredient, and accepts paste-a-URL. Approved recipes go in the bucket.
- **Weekly recap auto-draft** — paste IG post URLs from last Friday; it pulls captions and writes a community-voice recap.
- **DJ playlist suggester** — generates a phase-shaped stair set with BPM and one-click Spotify search links.
- **Approval bucket** — every drafted section can be approved. The bucket assembles a Beehiiv-ready issue in one click.

## Setup

```bash
cp .env.example .env       # add OPENAI_API_KEY (and optional SERPAPI_KEY for web recipe search)
npm install
# add IG post URLs:
echo "https://www.instagram.com/p/XXXX/" >> data/corpus/ig-urls.txt
# drop additional voice samples as markdown into data/corpus/paste/
npm run setup              # ingest IG + paste + site URLs → embeddings → style guide
npm run dashboard          # open http://localhost:3000
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run ingest` | Build voice corpus from `data/corpus/ig-urls.txt`, `site-urls.txt`, `paste/*.md` |
| `npm run build-index` | Chunk + embed corpus |
| `npm run build-style` | Auto-derive `prompts/fs-style.md` from the corpus |
| `npm run scan-news` | Pull fitness-trend news into `data/news/index.json` |
| `npm run scan-recipes` | Walk recipe sites, store candidates |
| `npm run generate -- --type <type> ...` | CLI draft of a single section |
| `npm run dashboard` | Launch the approval / assembly UI |

### Generate via CLI

```bash
npm run generate -- --type recipe-blurb --url https://minimalistbaker.com/...
npm run generate -- --type workout-tip --focus "descent control"
npm run generate -- --type weekly-recap --notes "Wild Friday, packed crowd, DJ rolled into Afrobeats around peak"
```

## Project layout

```
scripts/          CLI entry points
src/              ingest, RAG, generation, recipes, IG, playlist, bucket
prompts/          system prompt + auto-generated style guide
data/corpus/      voice samples (IG captions, pasted blurbs, site copy)
data/news/        scanned fitness news
data/recipes/     scraped recipe candidates
data/approved/    the Beehiiv bucket (per-section JSON)
public/           dashboard
```

## Notes

- **Beehiiv** integration is intentionally _not_ wired to the API — approved items assemble into a markdown blob you paste/import into Beehiiv. Add the Publications API later if you want one-click push.
- **Spotify playlist** creation is search-link only (no OAuth). One click per track to add it in the Spotify app.
- **Instagram** ingest uses public embed pages — works for public posts without auth. Private posts won't fetch; use the paste-markdown fallback in `data/corpus/paste/`.

_Friday Stairs is a community workout — content drafted by this tool is not medical advice._
