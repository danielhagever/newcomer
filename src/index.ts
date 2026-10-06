import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchNeighborhoods, weekendStop, KINDS, type Interest, type Kind, type MatchResult } from "./match.ts";
import { AppError, Budget, REQUEST_BUDGET, allow } from "./limits.ts";
import { normalizeName } from "./qloo.ts";
import { MAX_CITY, MAX_INTERESTS, MAX_NAME, MAX_PARSED, cleanCity, cleanInterests, parseInterests } from "./input.ts";

export interface Env {
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  QLOO_MIN_GAP_MS?: string;
  CACHE: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
}

// Per address, per hour. A search is 3 to 29 Qloo calls (measured); parsing is one Workers AI call.
const LIMITS = { parse: 30, match: 20, mcp: 20 };

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const failure = (e: unknown) => {
  if (e instanceof AppError) return { message: e.message, status: e.status >= 400 && e.status <= 599 ? e.status : 500 };
  console.error("newcomer", String((e as Error)?.stack ?? e));
  return { message: "Something went wrong on our side. Please try again.", status: 500 };
};

// Bump whenever the pipeline or the result format changes, so no one gets yesterday's logic.
const CACHE_VERSION = 51;

// Returns the result and whether it came from the day's cache (the page says so: the timings in
// "How we know" are from the run that made it). Only a new search passes the hourly gate: a saved answer
// costs no Qloo calls, so it doesn't count.
async function cachedMatch(env: Env, budget: Budget, city: string, interests: Interest[], gate: () => Promise<boolean>): Promise<MatchResult & { cached?: boolean }> {
  const key = `match${CACHE_VERSION}:` + (await sha(JSON.stringify([city.toLowerCase(), interests.map((i) => [i.name.toLowerCase(), i.query?.toLowerCase() ?? "", i.kind ?? "", i.id ?? ""])])));
  if (budget.take()) {
    try {
      const hit = await env.CACHE.get(key, "json");
      if (hit) return { ...(hit as MatchResult), cached: true };
    } catch {
      // A cache miss is fine.
    }
  }
  if (!(await gate())) throw new AppError("Too many searches from this address in the last hour (saved answers still work). Please try again later.", 429);
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
  // Not a place named just like the city ("think Skydeck Chicago and Chicago": a coffee shop, live).
  const city = normalizeName(r.city.split(",")[0]);
  const ev = [...a.matches, ...a.evidence]
    .filter((e) => weekendStop(e) && normalizeName(e.name) !== city)
    .slice(0, 2)
    .map((e) => e.name)
    .join(" and ");
  // A sentence starts with a capital, even with OpenStreetMap's "around Momont Road" (live, Missoula).
  const next = b ? ` ${b.name.charAt(0).toUpperCase()}${b.name.slice(1)}${c ? ` and ${c.name} come` : " comes"} next.` : "";
  return `In ${r.city}, ${a.name} fits your taste best${ev ? `: think ${ev}` : ""}.${next}`;
}

// What an agent should tell the person before relying on the answer.
function caveats(r: MatchResult): string {
  const unsure = r.resolved.filter((x) => x.match === "closest" || x.match === "ambiguous");
  const parts = unsure.map(
    (x) =>
      `"${x.input}" was matched to ${x.as} [id ${x.id}] (${x.match === "closest" ? "closest Qloo match, not an exact name" : "several Qloo entries share this name; the first was used"})${x.alternatives.length ? `; alternatives: ${x.alternatives.map((a) => `${a.name}${a.type && !a.type.startsWith("urn:") ? ` (${a.type})` : ""} [id ${a.id}]`).join(", ")}` : ""}.`,
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
        "For someone moving to a city: ranks the city's neighborhoods by how strongly the people there share the person's tastes (Qloo heatmap), names the places that show it, and drafts a two-day scouting weekend. Pass each interest by its English name as Qloo knows it, accents kept ('Fauda', not 'פאודה'; 'Björk'), with a kind (artist, movie, tv_show, book, podcast, video_game, brand, place, or tag for cuisines, activities and genres). If a name was only a closest match, or several Qloo entries share it, the answer says which entry was used, with its Qloo id, and lists any alternatives with theirs: ask the person whether it's the one they meant; to use another, call again with that id on the interest. Send one tool call per request.",
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
      try {
        const clean = cleanInterests(interests);
        const where = cleanCity(city);
        if (where.length < 2 || !clean.length) throw new AppError("Please give a city and at least one thing the person loves.", 400);
        const r = await cachedMatch(env, budget, where, clean, () => allow(req, "mcp", LIMITS.mcp, budget));
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

// The batch check reads the body before the MCP library does, so it reads at most 256 KB (a real call is a few
// KB): a huge body is refused at once instead of being read and parsed in full.
const MAX_MCP_BODY = 262_144;
async function mcpBody(req: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get("content-length")) > MAX_MCP_BODY) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MCP_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return all;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // One tool call per HTTP request: a JSON-RPC batch of several would run them side by side, each with its own
      // 48-call budget and Qloo pacing, so together they could break both.
      if (req.method === "POST") {
        const bytes = await mcpBody(req);
        if (!bytes) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } }, 413);
        let body: unknown = null;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          // Not JSON: the MCP library answers that.
        }
        if (Array.isArray(body) && body.filter((m) => m?.method === "tools/call").length > 1)
          return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one tool call per request." } }, 400);
        req = new Request(req.url, { method: "POST", headers: req.headers, body: bytes });
      }
      return createMcpHandler(() => buildServer(env, req)).fetch(req);
    }
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
      // A search counts once against the hourly limit: when its text is parsed first (a Workers AI call), or
      // when it isn't in the day's cache.
      let counted = false;
      const gate = async () => counted || (counted = await allow(req, "match", LIMITS.match, budget));
      try {
        if (!all.length) {
          if (!(await gate())) return json({ error: "Too many searches from this address in the last hour. Please try again later." }, 429);
          budget.take(); // the Workers AI call may count as a subrequest too
          all = await parseInterests(env.AI, text);
        }
        // A search uses the first 8; the rest are named, not silently dropped.
        const interests = all.slice(0, MAX_INTERESTS);
        const leftOut = all.slice(MAX_INTERESTS).map((i) => i.name);
        const r = await cachedMatch(env, budget, city, interests, gate);
        return json({ ...r, summary: summary(r), interests, leftOut });
      } catch (e) {
        const f = failure(e);
        return json({ error: f.message }, f.status);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
