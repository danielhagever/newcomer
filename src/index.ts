import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchNeighborhoods, weekendStop, KINDS, type Interest, type Kind, type MatchResult } from "./match.ts";
import { AppError, Budget, REQUEST_BUDGET, allow } from "./limits.ts";
import { MAX_CITY, MAX_INTERESTS, MAX_NAME, MAX_PARSED, cleanCity, cleanInterests, parseInterests } from "./input.ts";

export interface Env {
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  CACHE: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
}

// Per address, per hour. A search is 3 to 20 Qloo calls (measured); parsing is one Workers AI call.
const LIMITS = { parse: 30, match: 20, mcp: 20 };

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const failure = (e: unknown) => {
  if (e instanceof AppError) return { message: e.message, status: e.status >= 400 && e.status <= 599 ? e.status : 500 };
  console.error("newcomer", String((e as Error)?.stack ?? e));
  return { message: "Something went wrong on our side. Please try again.", status: 500 };
};

// Bump whenever the pipeline or the result format changes, so no one gets yesterday's logic.
const CACHE_VERSION = 10;

// Returns the result and whether it came from the day's cache (the page says so: the timings in
// "How we know" are from the run that made it).
async function cachedMatch(env: Env, budget: Budget, city: string, interests: Interest[]): Promise<MatchResult & { cached?: boolean }> {
  const key = `match${CACHE_VERSION}:` + (await sha(JSON.stringify([city.toLowerCase(), interests.map((i) => [i.name.toLowerCase(), i.query?.toLowerCase() ?? "", i.kind ?? "", i.id ?? ""])])));
  if (budget.take()) {
    try {
      const hit = await env.CACHE.get(key, "json");
      if (hit) return { ...(hit as MatchResult), cached: true };
    } catch {
      // A cache miss is fine.
    }
  }
  const r = await matchNeighborhoods(env, budget, city, interests);
  // Results with a failed optional step are shown but not kept, so a hiccup isn't served all day.
  if (!r.degraded && budget.take()) {
    try {
      await env.CACHE.put(key, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 });
    } catch {
      // Daily KV write limit or a hiccup: the result is still returned.
    }
  }
  return r;
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function summary(r: MatchResult): string {
  const [a, b, c] = r.neighborhoods;
  if (!a) return `I couldn't find a neighborhood match in ${r.city}.`;
  // Name places worth going to (the weekend's rule), your own kinds of places first.
  const ev = [...a.matches, ...a.evidence]
    .filter(weekendStop)
    .slice(0, 2)
    .map((e) => e.name)
    .join(" and ");
  const next = b ? ` ${b.name}${c ? ` and ${c.name} come` : " comes"} next.` : "";
  return `In ${r.city}, ${a.name} fits your taste best${ev ? `: think ${ev}` : ""}.${next}`;
}

// What an agent should tell the person before relying on the answer.
function caveats(r: MatchResult): string {
  const unsure = r.resolved.filter((x) => x.match === "closest" || x.match === "ambiguous");
  const parts = unsure.map(
    (x) =>
      `"${x.input}" was matched to ${x.as} (${x.match === "closest" ? "closest Qloo match, not an exact name" : "several Qloo entries share this name; the first was used"})${x.alternatives.length ? `; alternatives: ${x.alternatives.map((a) => `${a.name}${a.type && !a.type.startsWith("urn:") ? ` (${a.type})` : ""} [id ${a.id}]`).join(", ")}` : ""}.`,
  );
  if (r.unresolved.length) parts.push(`Not found in Qloo: ${r.unresolved.join(", ")}.`);
  return parts.join(" ");
}

function buildServer(env: Env, req: Request): McpServer {
  const server = new McpServer({ name: "newcomer", version: "0.2.0", title: "Newcomer: neighborhoods that share your taste" });
  server.registerTool(
    "find_neighborhoods",
    {
      title: "Find neighborhoods that share your taste",
      description:
        "For someone moving to a city: ranks the city's neighborhoods by how strongly the people there share the person's tastes (Qloo heatmap), names the places that show it, and drafts a two-day scouting weekend. Pass each interest by its English name as Qloo knows it, accents kept ('Fauda', not 'פאודה'; 'Björk'), with a kind (artist, movie, tv_show, book, podcast, video_game, brand, place, or tag for cuisines, activities and genres). If a name was only a closest match, or several Qloo entries share it, the result lists alternatives with their Qloo IDs: ask the person which one they meant, then call again with that id on the interest.",
      inputSchema: z.object({
        city: z.string().min(2).max(MAX_CITY).describe("City the person is moving to, with its state or country, e.g. 'Austin, Texas'"),
        interests: z
          .array(
            z.object({
              name: z.string().min(1).max(MAX_NAME),
              kind: z.enum(KINDS as [Kind, ...Kind[]]).optional(),
              id: z.string().max(80).optional().describe("A Qloo ID from an earlier result's alternatives, to pin the meaning"),
            }),
          )
          .min(1)
          .max(MAX_INTERESTS),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ city, interests }) => {
      const budget = new Budget(REQUEST_BUDGET);
      if (!(await allow(req, "mcp", LIMITS.mcp, budget)))
        return { content: [{ type: "text", text: "Too many searches from this address in the last hour. Please try again later." }], isError: true };
      try {
        const clean = cleanInterests(interests);
        const r = await cachedMatch(env, budget, cleanCity(city), clean);
        const s = summary(r);
        const notes = caveats(r);
        return { content: [{ type: "text", text: notes ? `${s}\n\n${notes}` : s }], structuredContent: { spoken: s, ...r } };
      } catch (e) {
        return { content: [{ type: "text", text: failure(e).message }], isError: true };
      }
    },
  );
  return server;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return createMcpHandler(() => buildServer(env, req)).fetch(req);
    if (url.pathname === "/favicon.ico") return Response.redirect(new URL("/favicon.svg", url).toString(), 301);
    if (url.pathname === "/api/status") return json({ qloo: !!env.QLOO_API_KEY });
    if (url.pathname === "/api/parse" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "Tell Newcomer what you love first." }, 400);
      if (!(await allow(req, "parse", LIMITS.parse))) return json({ error: "Too many requests from this address in the last hour. Please try again later." }, 429);
      return json({ interests: await parseInterests(env.AI, text) });
    }
    if (url.pathname === "/api/match" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { city?: unknown; text?: unknown; interests?: unknown } | null;
      const city = cleanCity(body?.city);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      let all = cleanInterests(body?.interests, MAX_PARSED);
      if (city.length < 2 || (!all.length && !text)) return json({ error: "Please give a city and at least one thing you love." }, 400);
      const budget = new Budget(REQUEST_BUDGET);
      if (!(await allow(req, "match", LIMITS.match, budget))) return json({ error: "Too many searches from this address in the last hour. Please try again later." }, 429);
      try {
        if (!all.length) {
          budget.take(); // the Workers AI call may count as a subrequest too
          all = await parseInterests(env.AI, text);
        }
        // A search uses the first 8; the rest are named, not silently dropped.
        const interests = all.slice(0, MAX_INTERESTS);
        const leftOut = all.slice(MAX_INTERESTS).map((i) => i.name);
        const r = await cachedMatch(env, budget, city, interests);
        return json({ ...r, summary: summary(r), interests, leftOut });
      } catch (e) {
        const f = failure(e);
        return json({ error: f.message }, f.status);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
