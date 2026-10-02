# Newcomer

**Moving to a new city? Find the neighborhood that already likes what you like.**

Live app: https://newcomer.meshulam791.workers.dev · MCP endpoint for agents: `https://newcomer.meshulam791.workers.dev/mcp`

## The problem

People who move for a job pick a neighborhood from rent listings, commute maps and a friend's guess. Then, months later, they find out whether the neighborhood actually fits their life: whether the coffee, the music, the food and the people are theirs. Relocation guides rank neighborhoods for everyone at once. A generic LLM will tell you "East Austin is trendy," which is the same answer for everyone.

Newcomer answers a personal question with evidence: **where in this city do the people who love the same things you love actually concentrate, and what proves it?**

## What it does

1. **Understands your taste.** You write what you love in plain words ("Phoebe Bridgers, The Bear, ramen, bouldering, natural wine"). A model turns that into typed interests, and Newcomer resolves each one in Qloo's taste graph the way Qloo's own harness does: artists, shows and films are searched as Qloo entities (5 candidates), cuisines and activities as Qloo tags (semantic search, 20 candidates), and only an exact name counts as a match. When there is no exact name, the closest one is used, marked "closest match", and the page offers the other candidates ("Not it?") so you can pick and run again. Anything Qloo doesn't know is reported, not guessed.
2. **Finds where that taste lives.** A Qloo heatmap (`filter.type=urn:heatmap`) scores the city for the combined taste profile. Qloo is asked about the city Newcomer located (so "Portland, ME" stays in Maine), several tags combine as `union` (any of your tastes), and an answer that lands far from the located city is asked again for 25 km around its centre, or refused.
3. **Names the neighborhoods.** If Qloo returns named neighborhoods they are used as they are. Otherwise the hottest map cells are named from OpenStreetMap and grouped, and ranked by mean affinity with a small boost for neighborhoods that hold several hot cells (Newcomer's rule, shown as such on the page).
4. **Shows the evidence.** For each of the top 3 neighborhoods, Qloo ranks nearby places (`filter.type=urn:entity:place` within 1.2 km) for the same signals. Those places are why the neighborhood fits: you can open them and judge for yourself.
5. **Plans a scouting weekend.** Saturday in the best match and Sunday in the runner-up, built from the evidence places, so you can test the move before signing a lease. Morning, afternoon and evening are Newcomer's guess from each place's tags, and the page says so.
6. **Shows its work.** A "How we know" panel lists every Qloo call with its parameters (the key never leaves the server), status, result count and time, then Newcomer's own rules, then the limits of the result.

It works as a web app and as an **MCP tool** (`find_neighborhoods`) that an agent can call (see below).

## Why it only works with Qloo

Without Qloo, an agent can only repeat what the internet says about neighborhoods in general. Qloo's heatmap measures where people who share *this* combination of tastes concentrate, and its place ranking shows which venues carry that taste. Remove Qloo and Newcomer has nothing to rank.

## Qloo workflows used

| Step | Endpoint and parameters | Why |
|---|---|---|
| Resolve artists, shows, films… | `GET /search?query=<name>&types=urn:entity:<type>&take=5` | Turn words into Qloo entity IDs; exact name or "closest match" with alternatives |
| Resolve cuisines, activities, genres | `GET /v2/tags?filter.query=<word>&feature.semantic_search=true&take=20` | Turn words into Qloo tag IDs, same rule |
| Where the taste concentrates | `GET /v2/insights?filter.type=urn:heatmap&filter.location.query=<located city>&signal.interests.entities=<ids>&signal.interests.tags=<ids>&operator.signal.interests.tags=union&output.heatmap.boundary=neighborhood&take=80` | Taste affinity per area. Same pattern as the `where_popular` workflow in Qloo's official harness (0.1.26). If Qloo refuses the boundary value, map cells are used; if the area is far from the city, `filter.location=POINT(lon lat)&filter.location.radius=25000` |
| Evidence places | `GET /v2/insights?filter.type=urn:entity:place&filter.location=POINT(lon lat)&filter.location.radius=1200&<same signals>&take=5` | Places that carry the taste in each neighborhood |

A search makes 5 to 22 Qloo calls: one or two per interest, one to three heatmaps, and three place lookups. Every external call is counted against Cloudflare's free-plan limit of 50 per request, so an optional step (naming map cells) stops early rather than failing the search.

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

When a name was only a closest match, the tool's text answer says so and lists the alternatives with their Qloo IDs; the tool description tells the agent to ask the person which one they meant and call again with that `id` on the interest. The full result (neighborhoods, evidence, weekend, every Qloo call) is in `structuredContent`.

## Request to result, redacted

_Filled in with a real run once the hackathon key is active: the input, the resolved entities and tags, the top heatmap cells, the neighborhood grouping, and the evidence places._

## Known limitations

- Qloo affinities describe what groups of people in an area tend to like. They are not predictions about any one person, and the app says so.
- Taste fit is one input. Rent, commute, schools and safety are deliberately out of scope, so the app is not used to judge housing eligibility or anything similar.
- No personal data is sent to Qloo: only public cultural signals (names of artists, shows, cuisines) and a city.
- Neighborhood names come from Qloo or, for map cells, from OpenStreetMap via Photon, and may differ from local usage.
- The neighborhood order and the weekend's times of day are Newcomer's rules on top of Qloo's numbers; the page labels them.
- Results are cached for a day per identical query to respect the event quota. A result where an optional step failed (a place lookup, a name) is shown but not cached.
- Each address can run 20 searches an hour, to protect the shared quota.

## Run it yourself

You need Node.js 22 or newer and a free Cloudflare account (Workers, KV and Workers AI are on the free plan).

```bash
git clone https://github.com/danielhagever/newcomer && cd newcomer
npm install
npm test                                          # 25 tests against a mock Qloo, no key needed
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
