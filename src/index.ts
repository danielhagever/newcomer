import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matchNeighborhoods, type Interest, type Kind, type MatchResult } from "./match";
import { QlooError } from "./qloo";

export interface Env {
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  CACHE: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
}

const KINDS: Kind[] = ["artist", "movie", "tv_show", "book", "podcast", "video_game", "brand", "place", "tag"];
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Turn "I love Phoebe Bridgers, The Bear, ramen and bouldering" into typed interests.
async function parseInterests(env: Env, text: string): Promise<Interest[]> {
  try {
    const out: any = await env.AI.run(
      "@cf/meta/llama-4-scout-17b-16e-instruct" as any,
      {
        messages: [
          {
            role: "system",
            content: `Extract the person's interests as JSON: {"interests":[{"name":"...","kind":"..."}]}. kind is one of ${KINDS.join(", ")}. Use "tag" for cuisines, activities, styles and genres (e.g. ramen, bouldering, jazz, vintage clothing). Use the exact proper name for artists, films, shows, books, podcasts, games and brands. At most 8 interests. Output JSON only.`,
          },
          { role: "user", content: text.slice(0, 600) },
        ],
        max_tokens: 400,
      } as any,
    );
    const raw = String(out?.response ?? out?.choices?.[0]?.message?.content ?? "");
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    const list: Interest[] = (parsed?.interests ?? [])
      .filter((i: any) => i?.name)
      .map((i: any) => ({ name: String(i.name).slice(0, 60), kind: KINDS.includes(i.kind) ? i.kind : "tag" }));
    if (list.length) return list.slice(0, 8);
  } catch {}
  // Fallback: split on commas and "and"; every item is tried as an entity name, then as a tag.
  return text
    .split(/,|\band\b|;/i)
    .map((s) => s.replace(/^(i (love|like|enjoy)|into)\s+/i, "").trim())
    .filter((s) => s.length > 1)
    .slice(0, 8)
    .map((name) => ({ name }));
}

async function cachedMatch(env: Env, city: string, interests: Interest[]): Promise<MatchResult> {
  const key = "match:" + (await sha(JSON.stringify([city.toLowerCase(), interests.map((i) => [i.name.toLowerCase(), i.kind])])));
  const hit = await env.CACHE.get(key, "json");
  if (hit) return hit as MatchResult;
  const r = await matchNeighborhoods(env, city, interests);
  await env.CACHE.put(key, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 });
  return r;
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function summary(r: MatchResult): string {
  const [a, b, c] = r.neighborhoods;
  if (!a) return `I couldn't find a neighborhood match in ${r.city}.`;
  const ev = a.evidence
    .slice(0, 2)
    .map((e) => e.name)
    .join(" and ");
  return `In ${r.city}, ${a.name} fits your taste best${ev ? `: think ${ev}` : ""}. ${b ? `${b.name}${c ? ` and ${c.name}` : ""} come next.` : ""}`.trim();
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "newcomer", version: "0.1.0", title: "Newcomer: neighborhoods that share your taste" });
  server.registerTool(
    "find_neighborhoods",
    {
      title: "Find neighborhoods that share your taste",
      description:
        "For someone moving to a city: ranks the city's neighborhoods by how strongly the people there share the person's tastes (Qloo heatmap), names the places that show it, and drafts a two-day scouting weekend. Pass interests as names with a kind (artist, movie, tv_show, book, podcast, video_game, brand, place, or tag for cuisines, activities and genres).",
      inputSchema: z.object({
        city: z.string().describe("City the person is moving to, e.g. 'Austin, Texas'"),
        interests: z
          .array(z.object({ name: z.string(), kind: z.enum(KINDS as [Kind, ...Kind[]]).optional() }))
          .min(1)
          .max(8),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ city, interests }) => {
      try {
        const r = await cachedMatch(env, city, interests);
        const s = summary(r);
        return { content: [{ type: "text", text: s }], structuredContent: { spoken: s, ...r } };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  );
  return server;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return createMcpHandler(() => buildServer(env)).fetch(req);
    if (url.pathname === "/api/status") return json({ qloo: !!env.QLOO_API_KEY });
    if (url.pathname === "/api/match" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { city?: string; text?: string; interests?: Interest[] } | null;
      if (!body?.city || (!body.text && !body.interests?.length)) return json({ error: "city and text (or interests) are required" }, 400);
      try {
        const interests = body.interests?.length ? body.interests.slice(0, 8) : await parseInterests(env, body.text!);
        const r = await cachedMatch(env, body.city.slice(0, 80), interests);
        return json({ ...r, summary: summary(r), interests });
      } catch (e) {
        const status = e instanceof QlooError ? e.status : 500;
        return json({ error: (e as Error).message }, status);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
