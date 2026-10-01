# Newcomer

**Moving to a new city? Find the neighborhood that already likes what you like.**

Live app: https://newcomer.meshulam791.workers.dev · MCP endpoint for agents: `https://newcomer.meshulam791.workers.dev/mcp`

## The problem

People who move for a job pick a neighborhood from rent listings, commute maps and a friend's guess. Then, months later, they find out whether the neighborhood actually fits their life: whether the coffee, the music, the food and the people are theirs. Relocation guides rank neighborhoods for everyone at once. A generic LLM will tell you "East Austin is trendy," which is the same answer for everyone.

Newcomer answers a personal question with evidence: **where in this city do the people who love the same things you love actually concentrate, and what proves it?**

## What it does

1. **Understands your taste.** You write what you love in plain words ("Phoebe Bridgers, The Bear, ramen, bouldering, natural wine"). A model turns that into typed interests, and Newcomer resolves each one in Qloo's taste graph: artists, shows and films become Qloo entities, cuisines and activities become Qloo tags. Anything Qloo doesn't know is reported, not guessed.
2. **Finds where that taste lives.** One Qloo heatmap call (`filter.type=urn:heatmap`) scores the city's map cells for that combined taste profile.
3. **Names the neighborhoods.** The hottest cells are grouped into neighborhoods using OpenStreetMap names, and ranked by mean affinity, with a small bonus for neighborhoods that hold several hot cells rather than one hot block.
4. **Shows the evidence.** For each top neighborhood, Qloo ranks the nearby places (`filter.type=urn:entity:place` within 1.2 km) for the same signals. Those places are why the neighborhood fits: you can open them and judge for yourself.
5. **Plans a scouting weekend.** Saturday in the best match and Sunday in the runner-up, built from the evidence places, so you can test the move before signing a lease.
6. **Shows its work.** A "How we know" panel lists every Qloo call with its parameters (the key never leaves the server), status, result count and time, plus the limits of the result.

It works as a web app and as an **MCP tool** (`find_neighborhoods`) that any agent can call, for example Claude, ChatGPT or a relocation company's own assistant.

## Why it only works with Qloo

Without Qloo, an agent can only repeat what the internet says about neighborhoods in general. Qloo's heatmap measures where people who share *this* combination of tastes concentrate, and its place ranking shows which venues carry that taste. Remove Qloo and Newcomer has nothing to rank.

## Qloo workflows used

| Step | Endpoint and parameters | Why |
|---|---|---|
| Resolve artists, shows, films… | `GET /search?query=<name>&types=urn:entity:<type>&take=1` | Turn words into Qloo entity IDs |
| Resolve cuisines, activities, genres | `GET /v2/tags?filter.query=<word>&take=1` | Turn words into Qloo tag IDs |
| Where the taste concentrates | `GET /v2/insights?filter.type=urn:heatmap&filter.location.query=<city>&signal.interests.entities=<ids>&signal.interests.tags=<ids>&take=80` (tries `output.heatmap.boundary=neighborhood` first) | Taste affinity per area. This is the same pattern as the `where_popular` workflow in Qloo's official harness. |
| Evidence places | `GET /v2/insights?filter.type=urn:entity:place&filter.location=POINT(lon lat)&filter.location.radius=1200&<same signals>&take=5` | Places that carry the taste in each neighborhood |

## Request to result, redacted

_Filled in with a real run once the hackathon key is active: the input, the resolved entities and tags, the top heatmap cells, the neighborhood grouping, and the evidence places._

## Known limitations

- Qloo affinities describe what groups of people in an area tend to like. They are not predictions about any one person, and the app says so.
- Taste fit is one input. Rent, commute, schools and safety are deliberately out of scope, so the app is not used to judge housing eligibility or anything similar.
- No personal data is sent to Qloo: only public cultural signals (names of artists, shows, cuisines) and a city.
- Neighborhood names come from OpenStreetMap via Photon and may differ from local usage.
- Results are cached for a day per identical query to respect the event quota.

## Run it yourself

```bash
npm install
npx wrangler kv namespace create newcomer-cache   # put the id in wrangler.jsonc
npx wrangler secret put QLOO_API_KEY             # your hackathon key, server-side only
npx wrangler deploy
QLOO_API_KEY=... node scripts/probe.mjs Austin    # prints response shapes, never the key
```

## Built with

Cloudflare Workers, KV and Workers AI (Llama 4 Scout, used only to parse free-text interests), Qloo Insights API, Open-Meteo geocoding, OpenStreetMap via Photon, Leaflet, and an MCP server (`@modelcontextprotocol/server` 2.2.0, Streamable HTTP).

## License

MIT
