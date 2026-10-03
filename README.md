# Newcomer

**Moving to a new city? Find the neighborhood that already likes what you like.**

Live app: https://newcomer.meshulam791.workers.dev · MCP endpoint for agents: `https://newcomer.meshulam791.workers.dev/mcp`

## The problem

People who move for a job pick a neighborhood from rent listings, commute maps and a friend's guess. Then, months later, they find out whether the neighborhood actually fits their life: whether the coffee, the music, the food and the people are theirs. Relocation guides rank neighborhoods for everyone at once. A generic LLM will tell you "East Austin is trendy," which is the same answer for everyone.

Newcomer answers a personal question with evidence: **where in this city do the people who love the same things you love actually concentrate, and what proves it?**

## What it does

1. **Understands your taste.** You write what you love in plain words ("Phoebe Bridgers, The Bear, ramen, bouldering, natural wine"; up to 8 are used, and any past 8 are named as left out). A model turns that into typed interests, and Newcomer resolves each one in Qloo's taste graph the way Qloo's own harness does: artists, shows and films are searched as Qloo entities (5 candidates), cuisines, activities and genres as Qloo tags (semantic search, 20 candidates), and an exact name is preferred. When there is no exact name, the closest candidate is used only if it resembles your words (allowing a typo or two); when there is none or several things share it (two films called "Dune"), the page says so, and "Not it?" lets you pick another and run again; it also offers the same name in other kinds (the model may have guessed "Dune" is the book when you meant the film). Anything Qloo doesn't know is reported, not guessed.
2. **Finds where that taste lives.** Qloo's heatmap scores every map cell of the city for the people who like your artists, shows, films and music genres. Food and activity tastes don't move Qloo's heatmap (measured: they come back with no tag affinity), so they are used where they work: to pick places. Qloo is asked about the city Newcomer located, and the locality Qloo used is shown ("Qloo read the city as Portland, Cumberland County, Maine") and checked against it.
3. **Names the neighborhoods.** The cells are grouped into squares of about 1 km (2.4 km where Qloo's cells are coarser, as over Los Angeles County) and ranked by the mean percentile of all their cells, so one hot block can't outrank a whole hot area; an area with your kinds of places within reach (ramen shops, bouldering gyms) gets a small boost, so every taste you typed counts. Each square is named by the neighborhood Qloo gives the places there; OpenStreetMap only fills in where Qloo has no name.
4. **Shows the evidence.** For each neighborhood: the places that ARE your food and activity tastes (Qloo place search filtered by those tags), and the places that people with your taste rate highly (Qloo places within 1.2 km, ranked by your taste signals). Schools, offices, places of worship and similar places are left out.
5. **Plans a scouting weekend.** Saturday in the best match and Sunday in the runner-up: one place per part of the day, using Qloo's own time-of-day fit for each place.
6. **Shows its work.** A "How we know" panel lists every Qloo call with its parameters (the key never leaves the server), status, result count and time, then Newcomer's own rules, then the limits of the result.

With only food and activity tastes, there is nothing for Qloo's heatmap to use, so Newcomer ranks neighborhoods by where the matching places are, and says so.

It works as a web app and as an **MCP tool** (`find_neighborhoods`) that an agent can call (see below).

## Why it only works with Qloo

Without Qloo, an agent can only repeat what the internet says about neighborhoods in general. Qloo's heatmap measures where people who share *this* combination of tastes concentrate, and its place ranking shows which venues carry that taste. Remove Qloo and Newcomer has nothing to rank.

## Qloo workflows used

| Step | Endpoint and parameters | Why |
|---|---|---|
| Resolve artists, shows, films… | `GET /search?query=<name>&types=urn:entity:<type>&take=5` | Turn words into Qloo entity IDs; exact name, or "closest" / "several share this name" with alternatives |
| Resolve cuisines, activities, genres | `GET /v2/tags?filter.query=<word>&feature.semantic_search=true&take=20` | Turn words into Qloo tag IDs. The same word comes back in many tag families; each lists the entity types it applies to (`parents`). Music genres go on the map; cuisines and activities (parent `urn:entity:place`) pick places |
| Where the taste concentrates | `GET /v2/insights?filter.type=urn:heatmap&filter.location.query=<located city>&signal.interests.entities=<ids>[&signal.interests.tags=<genres>]` | Every cell of the city with its affinity percentile, and the locality Qloo used. Same pattern as the `where_popular` workflow in Qloo's official harness (0.1.26). If Qloo's locality is far from the located city: `filter.location=POINT(lon lat)&filter.location.radius=25000` |
| Taste places per neighborhood | `GET /v2/insights?filter.type=urn:entity:place&filter.location=POINT(lon lat)&filter.location.radius=1200&signal.interests.entities=<ids>&take=8` | Places people with your taste rate highly; their `properties.neighborhood` names the area, their time-of-day tags plan the weekend |
| Your kinds of places | `GET /v2/insights?filter.type=urn:entity:place&filter.location.query=<city>&filter.tags=<cuisine/activity tags>&operator.filter.tags=union&signal.interests.entities=<ids>&take=50` | Ramen shops, bouldering gyms and natural wine bars, ranked by your taste |

In more than 20 live test searches (Austin, Los Angeles, Brooklyn, Chicago, Portland ME, London, Berlin, Tel Aviv and more) a cold search made 3 to 20 Qloo calls, including retries after a 429, and took 2.6 to 15 seconds; repeats are cached for a day. A search can never make more than 48 external calls in total (a per-request budget in `src/limits.ts`). Place calls run three at a time with one bounded retry, because Qloo answers a burst with 429. Every external call is counted against Cloudflare's free-plan limit of 50 per request, so an optional step stops early rather than failing the search.

### What the live API taught us (measured 2026-10-03)

- The heatmap has no neighborhood boundary (`output.heatmap.boundary` accepts only `urn:geohash` or `urn:entity:locality`), ignores `take` and `page`, and returns every cell: 1,435 for Austin, 4,860 for Brooklyn with a jazz signal. `affinity` is the cell's percentile in the city (1 = the best cell).
- `take` above 50 is a 400 on insights.
- Cells are geohash-7 (~150 m) for a city and geohash-6 (~1.2 x 0.6 km) for a big county.
- Cuisine and activity tags have no effect on the heatmap (tags-only heatmap: 0 cells; with entities, `tag_affinity` is null), but filter places well.

## Use it from an agent

`https://newcomer.meshulam791.workers.dev/mcp` is Newcomer's own MCP server (Streamable HTTP, no sign-in). It is not one of Qloo's hosted MCP endpoints: it calls Qloo's REST API on the server with the event key, which never reaches the agent. It has one tool, `find_neighborhoods(city, interests[])`.

- Claude Code: `claude mcp add --transport http newcomer https://newcomer.meshulam791.workers.dev/mcp`
- Claude, ChatGPT and other clients that accept a remote MCP URL: add it as a custom connector.
- Any HTTP client:

```bash
curl -s https://newcomer.meshulam791.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find_neighborhoods","arguments":{"city":"Austin, Texas","interests":[{"name":"Phoebe Bridgers","kind":"artist"},{"name":"ramen","kind":"tag"}]}}}'
```

Qloo's names are English: an agent passes the English name ("Fauda", not "פאודה"), with accents kept ("Björk"). The web page does this itself: the person can type in any language and sees what was typed, while Qloo is searched with the English name.

When a name was only a closest match, the tool's text answer says so and lists the alternatives with their Qloo IDs; the tool description tells the agent to ask the person which one they meant and call again with that `id` on the interest. The full result (neighborhoods, evidence, weekend, every Qloo call) is in `structuredContent`.

## Request to result, redacted

A real run on 2026-10-04 (no personal data; the key is not shown anywhere).

**Input:** "Moving to Austin, Texas. I love Phoebe Bridgers, The Bear, ramen, bouldering, natural wine."

1. **Parsed** (Workers AI): Phoebe Bridgers (artist), The Bear (TV show), ramen, bouldering, natural wine (tastes).
2. **Resolved in Qloo:** Phoebe Bridgers → artist `AFBC71A7-…` (exact); The Bear → TV show `4C305B2F-…` "The Bear (2022,2026)" (exact); ramen → `urn:tag:cuisine:qloo:ramen`, bouldering → `urn:tag:activity_type:qloo:bouldering`, natural wine → `urn:tag:cuisine:qloo:natural_wine` (exact names; place tags, so they pick places).
3. **Heatmap:** Qloo read the city as "Austin, Travis County, Texas, United States" and scored 1,435 cells for the artist and the show.
4. **Your kinds of places:** one city-wide Qloo place search filtered by the three place tags found 25 ramen, bouldering and natural wine places.
5. **Areas:** cells grouped into ~1 km squares, ranked by mean percentile plus 0.03 per matching place within 1.2 km, named from Qloo's places: Downtown (mean 0.79), Brentwood (0.72; EurAsia Ramen), Zilker (0.70; Ramen Tatsu-Ya), East Cesar Chavez (0.65; LoLo and Ramen Tatsu-Ya, lifted by them), Clarksville (0.71).
6. **Taste places downtown:** Stevie Ray Vaughan Statue, Franklin Barbecue, Austin City Limits Live.
7. **Weekend:** Saturday downtown: Stevie Ray Vaughan Statue (morning), Franklin Barbecue (afternoon), ACL Live (evening). Sunday in Brentwood: épicerie (morning), EurAsia Ramen (afternoon).

16 Qloo calls; the page's "How we know" panel lists each one with its parameters, status, count and time.

## Known limitations

- Qloo affinities describe what groups of people in an area tend to like. They are not predictions about any one person, and the app says so.
- Taste fit is one input. Rent, commute, schools and safety are deliberately out of scope, so the app is not used to judge housing eligibility or anything similar.
- No personal data is sent to Qloo: only public cultural signals (names of artists, shows, cuisines) and a city.
- Food and activity tastes pick places but don't shape Qloo's heatmap; with only those, neighborhoods are ranked by matching places, which is thinner evidence.
- A word that isn't an exact Qloo name is only used if it resembles what was typed (allowing a typo or two); anything else is reported as not found, because Qloo's semantic search returns something for any text.
- Neighborhood names are Qloo's (from its place data), with OpenStreetMap where Qloo has none; they may differ from local usage, and Qloo sometimes uses a district name ("Near North Side") next to the neighborhoods inside it.
- The area squares, their ranking (including the small boost for your kinds of places), the left-out place types and the weekend picks are Newcomer's rules on top of Qloo's numbers; the page labels them.
- Results are cached for a day per identical query to respect the event quota. A result where an optional step failed is shown but not cached.
- Each address can run 20 searches an hour, to protect the shared quota.
- A city typed in Hebrew, Arabic or Cyrillic is found in its own language and then asked about in English; other scripts need the English name.

## Run it yourself

You need Node.js 22 or newer and a free Cloudflare account (Workers, KV and Workers AI are on the free plan).

```bash
git clone https://github.com/danielhagever/newcomer && cd newcomer
npm install
npm test                                          # 56 tests against a mock Qloo shaped like the live API, no key needed
npx wrangler login
npx wrangler kv namespace create newcomer-cache   # put the id in wrangler.jsonc
npx wrangler secret put QLOO_API_KEY             # your hackathon key, server-side only
npx wrangler deploy
QLOO_API_KEY=... node scripts/probe.mjs "Austin, Texas"   # checks the live API's shapes, never prints the key
```

Locally: put `QLOO_API_KEY=...` in `.dev.vars` (git-ignored) and run `npx wrangler dev`. To try the page without a key, run `node test/mock-qloo-server.mjs` and set `QLOO_API_KEY=mock` and `QLOO_BASE_URL=http://localhost:8799` in `.dev.vars`; every name it returns says "(mock)".

## Built with

Cloudflare Workers, KV and Workers AI (Llama 4 Scout, used only to parse free-text interests), Qloo's API (search, tags, insights heatmap and places), Open-Meteo geocoding, OpenStreetMap via Photon, Leaflet, and an MCP server (`@modelcontextprotocol/server` 2.2.0, Streamable HTTP).

## License

MIT
