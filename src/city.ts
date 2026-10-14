// Where a city is (Open-Meteo geocoding), so Qloo is asked about the right one ("Portland, Maine", not Portland,
// Oregon), how far apart two points are, and how far a city reaches. Byte-identical in Newcomer and Booker: change one,
// copy it to the other.
// Caching is best effort: the free plan allows 1,000 KV writes a day, and a failed write must never fail a search.

import { AppError, Budget, UA, fetchWithTimeout } from "./limits.ts";
import { plainLetters } from "./names.ts";

export interface Place {
  lat: number;
  lon: number;
  name: string; // what the page shows, e.g. "Portland, Maine"
  query: string; // what Qloo is asked for: the same city, spelled out
  country?: string; // ISO code, e.g. "US"
  population?: number; // Open-Meteo's, which sizes a circle around the city (Newcomer's widened place search, Booker's misread city)
  // Set when what came after the comma isn't this city's state or country ("Chicago, Austin"): the city
  // was then taken as the most populous of its name, and the answer says how it was read.
  unmatched?: string;
  regionAs?: string; // with unmatched: the region as it fit once directions were dropped ("Northern Norway" as "Norway")
}

const US_STATES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado", ct: "Connecticut",
  de: "Delaware", dc: "District of Columbia", fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho", il: "Illinois",
  in: "Indiana", ia: "Iowa", ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland",
  ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi", mo: "Missouri", mt: "Montana",
  ne: "Nebraska", nv: "Nevada", nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico", ny: "New York",
  nc: "North Carolina", nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania",
  ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee", tx: "Texas", ut: "Utah",
  vt: "Vermont", va: "Virginia", wa: "Washington", wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming",
};
// Province and state codes outside the US ("Toronto, ON", "Melbourne, VIC"); a code can name more than one
// region (NT: Northwest Territories or Northern Territory), and the city's own record decides which.
const OTHER_REGIONS: Record<string, string[]> = {
  on: ["Ontario"], qc: ["Quebec"], bc: ["British Columbia"], ab: ["Alberta"], mb: ["Manitoba"], sk: ["Saskatchewan"],
  ns: ["Nova Scotia"], nb: ["New Brunswick"], nl: ["Newfoundland and Labrador"], pe: ["Prince Edward Island"], yt: ["Yukon"],
  nu: ["Nunavut"], nt: ["Northwest Territories", "Northern Territory"], nsw: ["New South Wales"], vic: ["Victoria"],
  qld: ["Queensland"], wa: ["Western Australia"], sa: ["South Australia"], tas: ["Tasmania"], act: ["Australian Capital Territory"],
  nyc: ["New York"], // "Brooklyn, NYC"
};
// The UK's nations are regions (admin1), not the whole UK: "Bangor, Wales" isn't Bangor in Northern Ireland.
const COUNTRY_WORDS: Record<string, string> = { usa: "us", "united states": "us", "united states of america": "us", us: "us", uk: "gb", "united kingdom": "gb", czech: "cz", "czech republic": "cz" };
// Territories, whose records carry no country name: their own name, and the country they belong to (Qloo files
// Puerto Rico's rooms as the US and Hong Kong's as China, live). "Ponce, Puerto Rico" landed in Cuba without this.
// Palestine's and Western Sahara's records have no country name either, and count as themselves ("Bethlehem,
// Palestine" was Bethlehem, South Africa).
export const TERRITORY: Record<string, [string, string]> = {
  PS: ["Palestine", "PS"], EH: ["Western Sahara", "EH"],
  PR: ["Puerto Rico", "US"], GU: ["Guam", "US"], VI: ["U.S. Virgin Islands", "US"], AS: ["American Samoa", "US"], MP: ["Northern Mariana Islands", "US"],
  HK: ["Hong Kong", "CN"], MO: ["Macau", "CN"],
  KY: ["Cayman Islands", "GB"], BM: ["Bermuda", "GB"], VG: ["British Virgin Islands", "GB"], TC: ["Turks and Caicos Islands", "GB"], AI: ["Anguilla", "GB"],
  MS: ["Montserrat", "GB"], FK: ["Falkland Islands", "GB"], GI: ["Gibraltar", "GB"], SH: ["Saint Helena", "GB"], JE: ["Jersey", "GB"], GG: ["Guernsey", "GB"], IM: ["Isle of Man", "GB"],
  GL: ["Greenland", "DK"], FO: ["Faroe Islands", "DK"], AW: ["Aruba", "NL"], CW: ["Curaçao", "NL"], SX: ["Sint Maarten", "NL"], BQ: ["Caribbean Netherlands", "NL"],
  PF: ["French Polynesia", "FR"], NC: ["New Caledonia", "FR"], RE: ["Réunion", "FR"], GP: ["Guadeloupe", "FR"], MQ: ["Martinique", "FR"], GF: ["French Guiana", "FR"],
  YT: ["Mayotte", "FR"], PM: ["Saint Pierre and Miquelon", "FR"], BL: ["Saint Barthélemy", "FR"], MF: ["Saint Martin", "FR"], WF: ["Wallis and Futuna", "FR"],
  AX: ["Åland", "FI"], SJ: ["Svalbard", "NO"], CK: ["Cook Islands", "NZ"], NU: ["Niue", "NZ"], NF: ["Norfolk Island", "AU"], CX: ["Christmas Island", "AU"],
};
// The country a place is in, a territory counted as its country's.
export const nation = (cc?: string) => (cc ? (TERRITORY[cc.toUpperCase()]?.[1] ?? cc.toUpperCase()) : undefined);
// A region's words, folded: hyphens part words ("Provence-Alpes-Côte d'Azur"), apostrophes join them ("Hawai'i").
const regionWords = (s: unknown) => fold(s).replace(/['’]/g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
// A typed region matches a longer state or country by whole words ("Ireland" is in Northern Ireland, "Sudan" in South
// Sudan, "Bengal" in West Bengal), except the same name with "New" in front, which is another place: "Hampshire" isn't
// New Hampshire, "Mexico" not New Mexico, "Wales" not New South Wales (live, unflagged). (Refusing every direction word
// in front too sent "Newry, Ireland" to a village in the Republic and "Juba, Sudan" away from South Sudan's capital.)
const newNamesake = (v: string, n: string) => v.endsWith(` ${n}`) && v.startsWith("new ");
// A county ("Winchester, Hampshire"; "Saint-Etienne, Loire" is the département) fits by whole words, a hyphenated name
// being one word: "Amalfi, Salerno" is in the Province of Salerno, "Vernon, Okanagan" in the Regional District of North
// Okanagan, "Lewes, Sussex" in East Sussex, "Killarney, Co. Kerry" in County Kerry; "Chatham, Kent" isn't Chatham-Kent
// (Ontario), nor "Saint-Etienne, Loire" a town in Loire-Atlantique. Not a US county (Americans write the state, and
// Open-Meteo writes US counties bare: "Southampton, Hampshire" was Southampton, Massachusetts), and not for a typed
// state or country ("Springdale, Washington" was Springdale, Arkansas, in Washington County).
const countyWords = (s: unknown) => fold(s).replace(/['’]/g, "").replace(/^co /, "");
const countyFits = (v: string, n: string) => ` ${v} `.includes(` ${n} `);

export async function kvGet(cache: KVNamespace, budget: Budget, key: string): Promise<any> {
  if (!budget.take()) return null;
  try {
    return await cache.get(key, "json");
  } catch {
    return null;
  }
}

export async function kvPut(cache: KVNamespace, budget: Budget, key: string, value: unknown, ttl: number): Promise<void> {
  if (!budget.take()) return;
  try {
    await cache.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // Daily write limit or a hiccup: the search still succeeds, it just isn't cached.
  }
}

// "Portland, Maine", "Portland, ME" and "Portland, Oregon" must each land on the right Portland:
// fetch several candidates and prefer the one whose state or country matches what came after the
// comma; otherwise take the most populous.
// Typed forms that Open-Meteo doesn't know by that name.
const ALIASES: Record<string, string> = {
  dc: "Washington, DC", "washington dc": "Washington, DC", cdmx: "Mexico City", "ciudad de mexico": "Mexico City",
  "quebec city": "Quebec, QC", "tel aviv-yafo": "Tel Aviv", "tel aviv yafo": "Tel Aviv", bangalore: "Bengaluru", bombay: "Mumbai",
  "st pete": "St. Petersburg, Florida",
  // Nicknames a tour itinerary uses (the venue matcher knows them too).
  la: "Los Angeles, California", sf: "San Francisco, California", philly: "Philadelphia, Pennsylvania", nola: "New Orleans, Louisiana",
  vegas: "Las Vegas, Nevada", atx: "Austin, Texas", chi: "Chicago, Illinois", kc: "Kansas City, Missouri", slc: "Salt Lake City, Utah",
  pdx: "Portland, Oregon", mpls: "Minneapolis, Minnesota", stl: "St. Louis, Missouri",
  // Old names Open-Meteo files elsewhere or not at all, as measured (pass 55: "Madras, India" was Madras, Oregon, "Peking,
  // China" Indonesia, "Saigon" alone Saigon, Chad; pass 56: "Calicut, India" a village 1,850 km off, "Mysore, India" a toll
  // gate); with the country only where the name is a town elsewhere (Canton, Michigan; Madras, Oregon). Other old names
  // are a known limit (test/geo.test.ts).
  "calcutta, india": "Kolkata, India", "madras, india": "Chennai, India", "canton, china": "Guangzhou, China",
  peking: "Beijing, China", saigon: "Ho Chi Minh City, Vietnam", "calicut, india": "Kozhikode, India",
  "allahabad, india": "Prayagraj, India", "mysore, india": "Mysuru, India", "cochin, india": "Kochi, India",
  "trivandrum, india": "Thiruvananthapuram, India", "pondicherry, india": "Puducherry, India",
  "leningrad, russia": "Saint Petersburg, Russia", "danzig, poland": "Gdańsk, Poland", "rangoon, myanmar": "Yangon, Myanmar",
  // Open-Meteo has no Newcastle upon Tyne under "Newcastle, UK"; islands are toured at their main town.
  ...Object.fromEntries(["uk", "gb", "england", "united kingdom", "great britain", "britain"].flatMap((r) => [`newcastle, ${r}`, `newcastle ${r}`]).map((k) => [k, "Newcastle upon Tyne, England"])),
  oahu: "Honolulu, Hawaii", kauai: "Lihue, Hawaii", "big island": "Hilo, Hawaii", // Maui is found as the island
  // The geocoder's first "Venice" is Dayton, Ohio (135,000 people to Venice's 51,000); "Venice, Florida" stays.
  venice: "Venice, Italy", "cd juarez": "Ciudad Juárez, Mexico",
};
// Big cities in their own language that Open-Meteo doesn't find by that name (measured 2026-10-13: "Roma, Italia" was a
// village of 87, "Wien" Wienau, "Lisboa" Mozambique; München, Praha, Moskva and Köln were found): the English name, the
// country's code and name. Used only with no region typed or that country ("Roma, Texas" stays Roma).
const NATIVE: Record<string, [string, string, string]> = {
  roma: ["Rome", "IT", "Italy"], milano: ["Milan", "IT", "Italy"], napoli: ["Naples", "IT", "Italy"], genova: ["Genoa", "IT", "Italy"],
  firenze: ["Florence", "IT", "Italy"], venezia: ["Venice", "IT", "Italy"], padova: ["Padua", "IT", "Italy"], mantova: ["Mantua", "IT", "Italy"],
  wien: ["Vienna", "AT", "Austria"], athina: ["Athens", "GR", "Greece"], lisboa: ["Lisbon", "PT", "Portugal"], kiev: ["Kyiv", "UA", "Ukraine"],
  bruxelles: ["Brussels", "BE", "Belgium"], warszawa: ["Warsaw", "PL", "Poland"], kobenhavn: ["Copenhagen", "DK", "Denmark"],
  "den haag": ["The Hague", "NL", "Netherlands"], "den bosch": ["'s-Hertogenbosch", "NL", "Netherlands"],
  bucuresti: ["Bucharest", "RO", "Romania"], "san sebastian": ["Donostia", "ES", "Spain"], "sankt petersburg": ["Saint Petersburg", "RU", "Russia"],
  bayrut: ["Beirut", "LB", "Lebanon"],
};
// Newspaper (AP) state abbreviations, dots dropped ("Paris, Tex.", "Springfield, Ill.").
const US_AP: Record<string, string> = {
  ala: "Alabama", ariz: "Arizona", ark: "Arkansas", calif: "California", colo: "Colorado", conn: "Connecticut", del: "Delaware",
  fla: "Florida", ill: "Illinois", ind: "Indiana", kan: "Kansas", kans: "Kansas", mass: "Massachusetts", mich: "Michigan",
  minn: "Minnesota", miss: "Mississippi", mont: "Montana", neb: "Nebraska", nebr: "Nebraska", nev: "Nevada", okla: "Oklahoma",
  ore: "Oregon", oreg: "Oregon", penn: "Pennsylvania", tenn: "Tennessee", tex: "Texas", wash: "Washington", wis: "Wisconsin",
  wyo: "Wyoming", wva: "West Virginia", "w va": "West Virginia", ont: "Ontario", que: "Quebec", alta: "Alberta", man: "Manitoba", sask: "Saskatchewan",
  pei: "Prince Edward Island",
};
// Countries as people write them in their own language.
const ENDONYMS: Record<string, string> = {
  brasil: "Brazil", deutschland: "Germany", espana: "Spain", italia: "Italy", osterreich: "Austria", schweiz: "Switzerland",
  suisse: "Switzerland", nederland: "Netherlands", sverige: "Sweden", norge: "Norway", danmark: "Denmark", polska: "Poland",
  eire: "Ireland", mexico: "Mexico", "great britain": "United Kingdom", britain: "United Kingdom", turkey: "Turkiye",
  uae: "United Arab Emirates", "czech republic": "Czechia", holland: "Netherlands", korea: "South Korea",
  // Spain's regions in Spanish, and in English as people spell them (Open-Meteo writes "Castille": "Toledo,
  // Castilla-La Mancha" was Toledo, Ohio; "Toledo, Castile-La Mancha" too).
  "castilla-la mancha": "Castille-La Mancha", "castilla la mancha": "Castille-La Mancha", "castile-la mancha": "Castille-La Mancha",
  "castile la mancha": "Castille-La Mancha", "castilla y leon": "Castille and León", "castile and leon": "Castille and León",
  "castile-leon": "Castille and León", "castilla-leon": "Castille and León", cataluna: "Catalonia", catalunya: "Catalonia",
  andalucia: "Andalusia", "pais vasco": "Basque Country", euskadi: "Basque Country", "comunidad valenciana": "Valencia",
  "comunitat valenciana": "Valencia", "valencian community": "Valencia", navarra: "Navarre", "islas baleares": "Balearic Islands",
  "illes balears": "Balearic Islands", "islas canarias": "Canary Islands", canarias: "Canary Islands", "region de murcia": "Murcia",
  "comunidad de madrid": "Madrid",
  // Denmark's regions in Danish (Open-Meteo writes them in English), and countries in their own language.
  sjaelland: "Zealand", hovedstaden: "Capital Region", syddanmark: "South Denmark", midtjylland: "Central Jutland",
  nordjylland: "North Denmark", belgique: "Belgium", belgie: "Belgium", ukraina: "Ukraine", hellas: "Greece", ellada: "Greece",
  suomi: "Finland", hrvatska: "Croatia", magyarorszag: "Hungary", cesko: "Czechia", rossiya: "Russia", srbija: "Serbia",
  slovensko: "Slovakia", slovenija: "Slovenia", eesti: "Estonia", latvija: "Latvia", lietuva: "Lithuania",
};
// Typed words are looked up in these tables, so they must not inherit Object's own names ("constructor", "__proto__").
for (const t of [US_STATES, OTHER_REGIONS, COUNTRY_WORDS, ALIASES, NATIVE, US_AP, ENDONYMS]) Object.setPrototypeOf(t, null);
// Accents dropped and letters written plain as people type them ("Trondelag" is Trøndelag, "Kirsehir" Kırşehir).
const fold = (s: unknown) => plainLetters(String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()).replace(/\./g, "").replace(/\s+/g, " ").trim();
// What a region word can mean: "tx" Texas, "on" Ontario, "wa" Washington or Western Australia.
const regionNames = (part: string) =>
  [part, US_STATES[part], US_AP[part], ...(OTHER_REGIONS[part] ?? []), ENDONYMS[part]].filter(Boolean).map((x) => fold(x));
// Countries (and the UK's nations) as typed, folded.
const COUNTRIES = new Set([
  ...Object.keys(COUNTRY_WORDS),
  ...("canada,australia,germany,france,spain,italy,ireland,netherlands,the netherlands,japan,mexico,brazil,israel,portugal,norway," +
    "sweden,denmark,finland,iceland,austria,switzerland,belgium,luxembourg,poland,czechia,hungary,greece,turkiye,croatia,slovenia," +
    "serbia,romania,bulgaria,estonia,latvia,lithuania,ukraine,northern ireland,scotland,wales,england,new zealand,south africa," +
    "argentina,chile,colombia,peru,south korea,korea,china,taiwan,india,thailand,vietnam,indonesia,philippines,singapore,malaysia," +
    "united arab emirates,egypt,morocco,nigeria,kenya").split(","),
]);
const KNOWN_REGIONS = new Set([
  ...Object.keys(US_STATES), ...Object.values(US_STATES).map(fold), ...Object.keys(US_AP), ...Object.keys(OTHER_REGIONS),
  ...Object.values(OTHER_REGIONS).flat().map(fold), ...Object.keys(ENDONYMS), ...COUNTRIES,
]);
// A typed US state is that state only, not a longer one with its name: "Huntington, VA" was Huntington, West Virginia.
const US_STATE_NAMES = new Set(Object.values(US_STATES).map(regionWords));
// A state followed by its country with no comma between them is two parts ("Salem, MA USA", "London, ON Canada"); a
// direction before a state stays one ("NE Ohio" is northeast Ohio, not Nebraska and Ohio: only a country can follow).
const splitRegion = (part: string): string[] => {
  const ws = part.split(/\s+/);
  for (let k = 1; k <= 2 && k < ws.length; k++) {
    const head = ws.slice(0, -k).join(" ");
    const tail = ws.slice(-k).join(" ");
    if (KNOWN_REGIONS.has(fold(head)) && COUNTRIES.has(fold(tail))) return [head, tail];
  }
  return [part];
};
// Directions typed before a region ("Bangor, North Wales", "Lancaster, North-West England", "Charleston, Southern West
// Virginia") are dropped one at a time while nothing fits, never from a region known whole (West Virginia, North
// Carolina), and the answer is flagged: the direction itself wasn't matched ("Newport, West Wales" is then the biggest
// Newport in Wales, not Pembrokeshire's).
const DIRECTIONS = "north|south|east|west|northern|southern|eastern|western|northeast|northwest|southeast|southwest|ne|nw|se|sw|northeastern|northwestern|southeastern|southwestern|central|mid|upper|upstate";
const DIRECTION = new RegExp(`^(${DIRECTIONS}) `);
const ONLY_DIRECTION = new RegExp(`^(${DIRECTIONS})$`);
// A region known whole keeps its direction (West Virginia), and a direction alone isn't a region ("North West" is
// England's, not "West": it fit West Virginia and West Java).
const dropDirection = (part: string) => {
  const spaced = part.replace(/-/g, " ");
  const rest = spaced.replace(DIRECTION, "");
  return KNOWN_REGIONS.has(spaced) || rest === spaced || ONLY_DIRECTION.test(rest) ? part : rest;
};
// The region as typed, then with one more direction dropped from each part at each step.
function regionLevels(parts: string[]): string[][] {
  const levels = [parts];
  for (let next = parts.map(dropDirection); next.some((p, i) => p !== levels[levels.length - 1][i]); next = next.map(dropDirection)) levels.push(next);
  return levels;
}
// One form for comparing place names across spellings: "Saint-Étienne", "St Etienne" and "St. Etienne" are the
// same name; so are "St. John's" and "St Johns".
const canon = (s: unknown) =>
  fold(s).replace(/['\u2019]/g, "").replace(/-/g, " ").replace(/\b(saint|sainte|fort|mount)\b/g, (w) => ({ saint: "st", sainte: "ste", fort: "ft", mount: "mt" })[w] as string).replace(/\s+/g, " ");
// "St. Paul", "Saint Paul" and "St Paul" are one place to a person, but Open-Meteo knows one spelling,
// anywhere in the name ("Bay St. Louis", "Port St. Lucie"). The short and the long form are both looked up.
const SHORT_LONG: [RegExp, string, string][] = [
  [/\b(st|saint)\b\.?/gi, "St.", "Saint"],
  [/\b(ste|sainte)\b\.?/gi, "Ste.", "Sainte"],
  [/\b(ft|fort)\b\.?/gi, "Ft.", "Fort"],
  [/\b(mt|mount)\b\.?/gi, "Mt.", "Mount"],
];
function spellings(name: string): string[] {
  const out = [name];
  for (const [re, short, long] of SHORT_LONG) {
    if (!re.test(name)) continue;
    for (const form of [short, long]) {
      const v = name.replace(re, form).replace(/\.\s*\./g, ".");
      // Compared as typed (dots kept): Open-Meteo answers "St John's" and "St. John's" differently.
      if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
  }
  return out.slice(0, 3);
}

// Letters Open-Meteo's search has no plain spelling for (measured 2026-10-13): ø and æ (all 20 Norwegian and Danish
// cities with them were missed typed plain), the Turkish dotless ı ("Diyarbakir" found only an airport, "Kirsehir"
// and "Bandirma" nothing) and the Polish ł (2026-10-14: 10 of 13 missed, "Slubice, Poland" was a Czech village). Å, ö,
// ü, ş, ğ and the like were found plain; Icelandic ð isn't retried ("Egilsstadir" isn't found), nor a name needing two
// letters changed ("Igdir" is Iğdır, "Vaerlose" Værløse).
// The countries and their regions (Open-Meteo's names; the Danish ones are in ENDONYMS), as folded.
const NORDIC = new Set([
  ..."norway,norge,no,denmark,danmark,dk,faroe islands,greenland,troms,finnmark,nordland,trondelag,more og romsdal,vestland".split(","),
  ..."rogaland,agder,vestfold,telemark,akershus,buskerud,ostfold,innlandet,oslo,zealand,capital region,south denmark".split(","),
  ..."central jutland,north denmark,sjaelland,hovedstaden,syddanmark,midtjylland,nordjylland".split(","),
]);
const TURKISH = new Set(["turkey", "turkiye", "tr"]);
const POLISH = new Set(["poland", "polska", "pl"]);
// One letter at its last place, then its first: "Tromso" -> Tromsø, Trømso; "Kirklareli" -> Kirklarelı, Kırklareli. (The
// geocoder ignores letter case, so a capital is swapped for a small letter.)
const swap = (name: string, from: string, to: string) => {
  const lower = name.toLowerCase();
  return [lower.lastIndexOf(from), lower.indexOf(from)].filter((i) => i >= 0).map((i) => name.slice(0, i) + to + name.slice(i + 1));
};
// The spellings to ask for instead, two at most: æ for ae ("Naestved"), else ø for an o; ı for an i; ł for an l.
function respellings(name: string, nordic: boolean, turkish: boolean, polish: boolean): string[] {
  const out = [
    ...(nordic ? (/ae/i.test(name) ? [name.replace(/ae/gi, "æ")] : swap(name, "o", "ø")) : []),
    ...(turkish ? swap(name, "i", "ı") : []),
    ...(polish ? swap(name, "l", "ł") : []),
  ];
  return [...new Set(out)].filter((n) => n !== name).slice(0, 2);
}

export async function cityCenter(cache: KVNamespace, budget: Budget, city: string): Promise<Place | null> {
  const key = `city32:${city.toLowerCase()}`; // city32: a hyphen at a word's edge, more old names
  const hit = await kvGet(cache, budget, key);
  if (hit) return hit as Place;
  // The typed parts, cleaned once before any step reads them: "Newcastle,UK" and "Newcastle , UK" are "Newcastle, UK";
  // in a region, signs other than dots, hyphens and apostrophes are spaces ("NC?", "Maine (USA)", "ME/USA"); a part with
  // no letter or digit is left out ("Venice,.", "Venice, -"); "MA USA" is two parts.
  // Quotes and accent signs are one apostrophe ("Hawai‘i", "Hawaiʻi", "Hawaiʼi", "Hawai´i"), and accents stay, even typed
  // apart; in a region "&" is "and", a word holding a digit is a gap (a postal code: "Portland, ME 04101", "Portland, ME
  // 04101-1234", "Springfield, Illinois, US, 62701", "London, ON N6A 1A1", which was London, England) when the region has
  // a word without one, and so is a hyphen not between two letters or digits ("Venice, -", " - ", what a postal code
  // leaves: "Riga, LV-1050" is Latvia's code). A region of only such words is kept: it fits nothing and is flagged
  // ("Portland, 04101" and "Cambridge, CB2 1TN" aren't checked; pass 52 dropped the first unflagged).
  const zipGap = city.split(",").slice(1).join(",").split(/[^\p{L}\p{N}]+/u).some((w) => /\p{L}/u.test(w) && !/\d/.test(w));
  const typedList = city
    .replace(/[\u2018\u2019\u02bb\u02bc\u00b4`]/g, "'")
    .split(",")
    .map((x, i) => (i ? x.replace(/&/g, " and ").replace(zipGap ? /[\p{L}\p{N}]*\d[\p{L}\p{N}]*/gu : /$^/, " ").replace(/(?<![\p{L}\p{N}])-+|-+(?![\p{L}\p{N}])/gu, " ").replace(/[^\p{L}\p{M}\p{N}\s.'-]/gu, " ") : x).replace(/\s+/g, " ").trim())
    .filter((x) => /[\p{L}\p{N}]/u.test(x))
    .flatMap((x, i) => (i ? splitRegion(x) : [x]));
  // A nickname typed with its region, then any further parts ("Newcastle, England, UK" is Newcastle upon Tyne). A name
  // alone is a nickname further down, where the typed region wins ("KC, Kansas" is Kansas City, Kansas).
  const alias = typedList.length > 1 ? ALIASES[fold(typedList.slice(0, 2).join(", "))] : undefined;
  const typed = (alias ? [alias, ...typedList.slice(2)] : typedList).join(", ");
  let [name, ...rest] = typed.split(",").map((x) => x.trim());
  if (!name) return null;
  // A nickname before the comma too: "Quebec City, QC", "Bangalore, India", "Washington DC, USA" (and, below,
  // before a region word without a comma: "Bangalore India").
  const unalias = () => {
    const alias = ALIASES[fold(name)];
    if (!alias) return;
    const [aliasName, ...aliasRest] = alias.split(",").map((x) => x.trim());
    name = aliasName;
    if (!rest.length) rest = aliasRest;
  };
  unalias();
  let whole: any[] | undefined; // the answer for the whole name, when it was already asked for
  // The state or country may close the name, before a comma or none ("Austin TX", "Portland Maine", "Portland ME,
  // USA"), but a city's own name may end in one too ("New Britain", "Port Washington", "West New York"): the whole name
  // is kept when Open-Meteo has a place with exactly that name.
  {
    const ws = name.split(/\s+/);
    const k = [3, 2, 1].find((k) => ws.length > k && KNOWN_REGIONS.has(fold(ws.slice(-k).join(" "))));
    if (k) {
      whole = await geocode(budget, name, "en");
      if (!whole.some((r) => fold(r.name) === fold(name))) {
        rest = [ws.slice(-k).join(" "), ...rest];
        name = ws.slice(0, -k).join(" ");
        whole = undefined;
        unalias();
      }
    }
  }
  // A big city typed in its own language that Open-Meteo doesn't find by that name, when no region was typed (then with
  // its country: "Venezia" alone, as the geocoder's first "Venice" is Dayton, Ohio) or a typed part is that country; "Roma,
  // Texas" stays Roma, and a part that isn't the country is set aside below ("Roma, Italia, Europe" was a village of 87).
  const native = NATIVE[fold(name)];
  const nativeCountry = (p: string) => !!native && (p === native[1].toLowerCase() || regionNames(p).includes(fold(native[2])));
  const typedParts = rest.map(fold).filter(Boolean);
  if (native && (!typedParts.length || regionLevels(typedParts).some((ps) => ps.some(nativeCountry)))) {
    name = native[0];
    if (!rest.length) rest = [native[2]];
  }
  // Each part after the name must fit the city: "Austin, TX, USA" is Texas and the United States.
  const parts = rest.map(fold);
  const levels = regionLevels(parts);
  const seen = new Set<unknown>();
  let list: any[] = [];
  const idOf = (r: any) => r.id ?? [r.name, r.admin1, r.country_code, r.latitude, r.longitude].join("|");
  // Another spelling only adds places of exactly that name: "Saint George" would add Freetown (Sierra Leone)
  // to "St. George", and "St. John" would add St. John's to "Saint John".
  // A name that only starts with the other spelling ("St. Petersburg" for "St Pete") counts when the typed
  // spelling found no place of exactly its name.
  let exactTyped = false;
  for (const [i, n] of spellings(name).entries()) {
    const found = i === 0 && whole ? whole : await geocode(budget, n, "en");
    if (i === 0) exactTyped = found.some((r) => canon(r.name) === canon(n));
    // A longer name counts ("St. Pete" -> St. Petersburg, "St. Simons" -> Saint Simons Island, "Ft. Walton" ->
    // Fort Walton Beach), except a French village name that goes on with a connector ("St. Denis" isn't
    // Saint-Denis-sur-Coise, "St Malo" isn't Saint-Malo-en-Donziois).
    const longer = (r: any) => {
      const more = canon(r.name).startsWith(canon(n)) ? canon(r.name).slice(canon(n).length) : null;
      return more !== null && !/^ (sur|sous|en|de|des|du|la|le|les|aux|et|d|l)( |$)/.test(more);
    };
    const keep = (r: any) => i === 0 || canon(r.name) === canon(n) || (!exactTyped && longer(r));
    for (const r of found) if (keep(r) && !seen.has(idOf(r))) (seen.add(idOf(r)), list.push(r));
  }
  // A city typed in Hebrew, Arabic or Cyrillic is only found in its own language; its English name
  // (what Qloo is asked about) then comes from the same place's record.
  const script = /[\u0590-\u05FF]/.test(name) ? "he" : /[\u0600-\u06FF]/.test(name) ? "ar" : /[\u0400-\u04FF]/.test(name) ? "ru" : "";
  if (!list.length && script) {
    const native = (await geocode(budget, name, script)).sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
    if (native?.id) list = await byId(budget, native.id);
  }
  // A part fits by name (a state, province or country, or their codes) or, failing that, as an ISO
  // country code; a state wins over a country code ("Richmond, CA" is California, not Canada).
  const byName = (r: any, part: string) => {
    // The state, the country, and for a territory its own name (and China for Hong Kong and Macau). A territory fits its
    // country by code words only ("Ponce, Puerto Rico, United States"), so "Saint-Denis, France" stays the one by
    // Paris, not Réunion's. The county as above.
    const own = [r.admin1, r.country ?? TERRITORY[r.country_code]?.[0], nation(r.country_code) === "CN" && "China"].filter(Boolean).map(regionWords);
    const county = r.admin2 && r.country_code !== "US" && !KNOWN_REGIONS.has(part) ? countyWords(r.admin2) : "";
    // Whole words only: "India" is in "Republic of India", not in "Indiana" (live: "Calcutta, India" was Calcutta,
    // Indiana; it is Kolkata now, by its old name); a hyphen parts words ("La Mancha" is in "Castilla-La Mancha", "Saxony" in "Saxony-Anhalt").
    return (
      regionNames(part).some((typedName) => {
        const n = regionWords(typedName);
        return own.some((v) => v === n || (n.length > 3 && ` ${v} `.includes(` ${n} `) && !newNamesake(v, n) && !US_STATE_NAMES.has(n))) || (!!county && countyFits(county, countyWords(typedName)));
      }) || [fold(r.country_code), fold(nation(r.country_code))].includes(COUNTRY_WORDS[part])
    );
  };
  const byCode = (r: any, part: string) => byName(r, part) || (part.length === 2 && part === fold(r.country_code));
  // Which typed parts fit some place among these; a part that fits none is set aside below ("Europe", "Narnia").
  const fitSome = (among: any[]) => parts.map((_, j) => among.some((r) => levels.some((ps) => byCode(r, ps[j]))));
  // A place fits the parts that fit some place among these: a part that fits none doesn't hold back the lookups that look
  // further ("Columbia, North Carolina, Europe" is found among 100 Columbias, "Tromso, Norway, Europe" spelled Tromsø;
  // pass 53: Columbia, South Carolina and a Norwegian island). When no part fits any, no place does.
  const fitsAmong = (among: any[]) => {
    const ok = fitSome(among);
    return (r: any) => (!parts.length || ok.some(Boolean)) && levels.some((ps) => ps.every((p, j) => !ok[j] || byCode(r, p)));
  };
  const typedNames = new Set([canon(name)]); // the typed name, and the respelling found for it (below)
  const exact = (r: any) => typedNames.has(canon(r.name));
  // French saints are filed with hyphens ("Saint-Étienne", "Saint-Malo"): asked for only when no spelling found
  // a place of exactly the typed name that fits what came after the comma.
  const saint = name.match(/^(st|saint|ste|sainte)\.?\s+(.+)$/i);
  const fitsFirst = fitsAmong(list); // the saint's lookup and the respellings below never both run (a space, or none)
  if (saint && !list.some((r) => exact(r) && fitsFirst(r))) {
    const hyphen = `${/^s(ain)?te$/i.test(saint[1]) ? "Sainte" : "Saint"}-${saint[2].trim().replace(/\s+/g, "-")}`;
    for (const r of await geocode(budget, hyphen, "en")) if (canon(r.name) === canon(hyphen) && !seen.has(idOf(r))) (seen.add(idOf(r)), list.push(r));
  }
  // A one-word name typed without ø, æ, ı or ł (above) is asked again with them when no town of exactly that name fits,
  // and the text names no country or a Nordic (Turkish, Polish) one or region. Places of exactly the new spelling are kept, or else the
  // first answer when it has people (the geocoder answers "Helsingør" with its English name, Elsinore, and "Rødovre"
  // with Rødovre Municipality; not an airport or a glacier). With no country typed only the first two spellings are
  // asked, the Nordic ones first: a Polish name typed alone is often missed ("Kolobrzeg"), and a region that names no
  // such country, a continent, asks none ("Tromso, Europe" is the island): known limits, as a name alone is.
  const town = (r: any) => /^PPL/.test(String(r.feature_code ?? "PPL"));
  if (!/\s/.test(name) && !list.some((r) => exact(r) && town(r) && fitsFirst(r))) {
    const typedIn = (set: Set<string>) => !parts.length || levels.some((ps) => ps.some((p) => set.has(p)));
    for (const n of respellings(name, typedIn(NORDIC), typedIn(TURKISH), typedIn(POLISH))) {
      const answer = await geocode(budget, n, "en");
      const same = answer.filter((r) => canon(r.name) === canon(n));
      const found = (same.length ? same : answer.slice(0, 1).filter((r) => r.population > 0)).filter((r) => !seen.has(idOf(r)));
      if (!found.some(fitsAmong([...list, ...found]))) continue;
      for (const r of found) (seen.add(idOf(r)), list.push(r), typedNames.add(canon(r.name)));
      break;
    }
  }
  if (!list.length) return null;
  const fitting = (ps: string[]) => {
    const named = list.filter((r) => ps.every((p) => byName(r, p)));
    return named.length ? named : list.filter((r) => ps.every((p) => byCode(r, p)));
  };
  let fitLevel = 0; // above 0: the region fit only with directions dropped, and is flagged
  const fits = () => {
    if (!parts.length) return [];
    for (const [i, ps] of levels.entries()) {
      const found = fitting(ps);
      fitLevel = i;
      if (found.length) return found;
    }
    return [];
  };
  const pop = (r: any) => r.population ?? 0;
  // A place of exactly the typed name is taken over a place of another name unless that one is over 10 times bigger (an
  // old name for a big city isn't a hamlet that happens to share it).
  const exactFirst = (xs: any[]) => {
    const named = xs.filter(exact);
    const biggest = Math.max(0, ...named.map(pop));
    return named.length && !xs.some((r) => !exact(r) && pop(r) > 10 * biggest) ? named : xs;
  };
  let matches = fits();
  // Open-Meteo lists the first 10 places of a name, and a smaller one that fits what came after the comma can be
  // further down (live: Newport, Rhode Island; Salem, Massachusetts; Jackson, Wyoming), or the first 10 can hold a
  // place of another name that fits (Oak Harbor, Ohio, for "Hartford, Ohio"). Only then are 100 asked for, keeping
  // places of exactly the typed name that fit the parts any of them fits (asking for 100 every time made Porto Porto
  // Alegre), preferred as above. The first 10's other names don't count here: "Testville Norte" fitting a typed country
  // mustn't keep out Testville itself.
  if (parts.length && !matches.some(exact)) {
    const sameName = (await geocode(budget, name, "en", 100)).filter((r) => exact(r) && !seen.has(idOf(r)));
    const more = sameName.filter(fitsAmong(sameName));
    if (more.length) (list.push(...more), (matches = fits()));
    matches = exactFirst(matches);
  }
  // A part that fits no place found, even among 100 and in the other spellings, doesn't throw away the parts that fit
  // ("Venice, Italy, Europe" was Dayton, Ohio): it is set aside and flagged ("Europe", "Narnia"); a place of the typed name
  // is preferred as above ("Hartford, OH, North America" was Oak Harbor, Ohio).
  let setAside: number[] = [];
  if (parts.length && !matches.length) {
    const fitsSome = fitSome(list);
    for (const [i, ps] of fitsSome.some(Boolean) ? levels.entries() : []) {
      const found = fitting(ps.filter((_, j) => fitsSome[j]));
      if (!found.length) continue;
      (matches = exactFirst(found)), (fitLevel = i), (setAside = parts.map((_, j) => j).filter((j) => !fitsSome[j]));
      break;
    }
  }
  const pool = matches.length ? matches : list;
  // Towns and cities first (Open-Meteo lists Vancouver Island above the city of Vancouver), unless an island
  // or region is far bigger than any town of that name (Long Island, Maui).
  const byPop = (xs: any[]) => [...xs].sort((a, b) => pop(b) - pop(a))[0];
  const biggestTown = byPop(pool.filter(town));
  const other = byPop(pool.filter((r) => !town(r)));
  const r = biggestTown && !(other && pop(other) > 10 * pop(biggestTown)) ? biggestTown : (other ?? biggestTown);
  // US and Canadian cities are named with their state or province; elsewhere with the country. The
  // region is kept even when it repeats the name: Qloo reads "New York" as the state and
  // "New York, New York" as the city (measured).
  // UK cities with their nation: Qloo reads "Bangor, United Kingdom" as Bangor in Northern Ireland and
  // "Bangor, Wales" right (measured). Québec with "City": "Québec, Quebec" is the province to Qloo.
  const region = r.country_code === "US" || r.country_code === "CA" || (r.country_code === "GB" && r.admin1) ? r.admin1 : (r.country ?? TERRITORY[r.country_code]?.[0] ?? r.admin1);
  const cityName = r.country_code === "CA" && fold(r.name) === "quebec" && fold(r.admin1) === "quebec" ? `${r.name} City` : r.name;
  const label = `${cityName}${region ? ", " + region : ""}`;
  const typedRegion = rest.join(", ");
  // What is flagged: all that was typed when nothing fit or directions were dropped ("West Wales, Cymru" fit only as
  // "Wales"), else the parts set aside.
  const flag = !matches.length || fitLevel ? typedRegion : setAside.map((j) => rest[j]).join(", ");
  // The typed words left once directions were dropped ("Western North Carolina" as "North Carolina"), the parts set
  // aside left out.
  const words = (s: string) => s.trim().split(/[\s-]+/);
  const shownAs = (ps: string[]) => rest.flatMap((typedPart, i) => (setAside.includes(i) ? [] : [words(typedPart).slice(words(typedPart).length - words(ps[i]).length).join(" ")])).join(", ");
  // Open-Meteo leaves out a coordinate that is exactly 0 (Stratford, London has no longitude).
  const out: Place = { lat: r.latitude ?? 0, lon: r.longitude ?? 0, name: label, query: label, ...(r.country_code ? { country: String(r.country_code) } : {}), ...(r.population ? { population: Number(r.population) } : {}), ...(flag ? { unmatched: flag } : {}), ...(matches.length && fitLevel ? { regionAs: shownAs(levels[fitLevel]) } : {}) };
  await kvPut(cache, budget, key, out, 60 * 60 * 24 * 30);
  return out;
}

async function geocode(budget: Budget, name: string, language: string, count = 10): Promise<any[]> {
  if (!budget.take()) throw new AppError("This search needs more lookups than one request allows.", 503);
  try {
    const res = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${count}&language=${language}`,
      { headers: UA },
      6000,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    return ((await res.json()) as any)?.results ?? [];
  } catch {
    throw new AppError("The city lookup service didn't answer. Please try again.", 502);
  }
}

async function byId(budget: Budget, id: number): Promise<any[]> {
  if (!budget.take()) return [];
  try {
    const res = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/get?id=${id}&language=en`, { headers: UA }, 6000);
    const r: any = res.ok ? await res.json() : null;
    return r?.name ? [r] : [];
  } catch {
    return [];
  }
}

// How far a circle around a city's centre reaches to cover the city: a disc holding its people at about 3,000 per
// km², from 3 to 25 km (Yonkers 5 km, Honolulu 6, Kyoto 12, Moscow 25). Unknown population: 3 km.
export const cityRadiusKm = (population?: number) => Math.min(25, Math.max(3, Math.round(Math.sqrt((population ?? 0) / 3000 / Math.PI))));

// What to tell the person when what followed the comma didn't fit the city as typed; a region that fit only without
// its direction says so ("Northern Norway" as Norway), not that it didn't match.
export const readNote = (typed: string, c: Place) =>
  c.unmatched ? `"${typed}" was read as ${c.name}; ${c.regionAs ? `"${c.unmatched}" fit only as "${c.regionAs}"` : `"${c.unmatched}" didn't match its state or country`}, so check this is the city you meant.` : undefined;

// A country's name in English from its code ("MC" is Monaco), or the code where the runtime has no name for it.
export const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

export function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
