// Everything that comes from a visitor or an agent is checked here before it reaches Qloo.

import { KINDS, validQlooId, type Interest, type Kind } from "./match.ts";

export const MAX_INTERESTS = 8;
export const MAX_NAME = 60;
export const MAX_CITY = 80;

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function cleanCity(v: unknown): string {
  return clean(v, MAX_CITY);
}

// Keeps only well-formed interests: a non-empty name, a known kind (or none), and a Qloo ID only
// if it looks like one.
export function cleanInterests(v: unknown): Interest[] {
  if (!Array.isArray(v)) return [];
  const out: Interest[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const name = clean((raw as any).name, MAX_NAME);
    if (!name) continue;
    const kind = KINDS.includes((raw as any).kind) ? ((raw as any).kind as Kind) : undefined;
    const id = clean((raw as any).id, 80);
    const as = clean((raw as any).as, 120);
    out.push({ name, ...(kind ? { kind } : {}), ...(id && validQlooId(id) ? { id, ...(as ? { as } : {}) } : {}) });
    if (out.length === MAX_INTERESTS) break;
  }
  return out;
}

// When the model can't parse the text: split on commas, semicolons and new lines only. Splitting on
// "and" would break "Simon and Garfunkel" or "rock and roll"; an unsplit "A and B" is reported as not
// found instead, which is honest.
export function fallbackInterests(text: string): Interest[] {
  return text
    .split(/[,;\n]+/)
    .map((s) => s.replace(/^\s*(i (really )?(love|like|enjoy)|into|and)\s+/i, "").trim())
    .filter((s) => s.length > 1)
    .slice(0, MAX_INTERESTS)
    .map((s) => ({ name: s.slice(0, MAX_NAME) }));
}

const SYSTEM = `Extract the person's interests as JSON: {"interests":[{"name":"...","kind":"..."}]}. kind is one of ${KINDS.join(", ")}. Use "tag" for cuisines, activities, styles and genres (e.g. ramen, bouldering, jazz, vintage clothing). Use the exact proper name for artists, films, shows, books, podcasts, games and brands. At most ${MAX_INTERESTS} interests. Output JSON only.`;

// "I love Phoebe Bridgers, The Bear, ramen and bouldering" -> typed interests (Workers AI).
export async function parseInterests(ai: Ai, text: string): Promise<Interest[]> {
  const input = text.slice(0, 600);
  try {
    const out: any = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct" as any, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: input },
      ],
      max_tokens: 400,
    } as any);
    const rawVal = out?.response ?? out?.choices?.[0]?.message?.content ?? "";
    // Some models return the JSON already parsed.
    const raw = typeof rawVal === "string" ? rawVal : JSON.stringify(rawVal);
    const m = raw.match(/\{[\s\S]*\}/);
    const list = cleanInterests(m ? JSON.parse(m[0])?.interests : []);
    if (list.length) return list.map(({ name, kind }) => ({ name, kind: kind ?? "tag" }));
  } catch {
    // Fall through to the plain split.
  }
  return fallbackInterests(input);
}
