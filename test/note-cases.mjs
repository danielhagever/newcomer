// Realistic inputs with a note in brackets, the kind, and what a reasonable person expects (a test on the pick's
// label "name (disambiguation)"), written before looking at Qloo's answers; those were recorded live on 2026-10-04
// (test/note-fixtures.json: the search for the whole text and for the name before the note). Shared by Newcomer
// and Booker.
const starts = (s) => (l) => l.toLowerCase().startsWith(s.toLowerCase());
const has = (...ss) => (l) => ss.every((s) => l.toLowerCase().includes(s.toLowerCase()));
const none = (l) => l === "none";
export const T = [
  // qualifiers: the note describes the thing
  ["Succession (TV series)", "tv_show", has("succession", "2018")],
  ["Dune (2021 film)", "movie", has("dune", "2021")],
  ["Wednesday (indie rock band)", "artist", (l) => /^wednesday( \(|$)/i.test(l)],
  ["Taylor Swift (singer)", "artist", starts("Taylor Swift")],
  ["Radiohead (band)", "artist", starts("Radiohead")],
  ["Adele (singer)", "artist", starts("Adele")],
  ["The Killers (band)", "artist", starts("The Killers")],
  ["Prince (musician)", "artist", (l) => /^prince( \(|$)/i.test(l)],
  ["Phoebe Bridgers (singer-songwriter)", "artist", starts("Phoebe Bridgers")],
  ["Big Thief (Adrianne Lenker)", "artist", starts("Big Thief")],
  ["Breaking Bad (TV show)", "tv_show", starts("Breaking Bad")],
  ["Fleabag (Amazon)", "tv_show", starts("Fleabag")],
  ["The Bear (FX)", "tv_show", has("the bear", "2022")],
  ["Wednesday (Netflix series)", "tv_show", has("wednesday", "2022")],
  ["Shrinking (Apple TV+)", "tv_show", starts("Shrinking")],
  ["The Office (US)", "tv_show", has("office", "2005")],
  ["The Office (UK)", "tv_show", has("office", "2001")],
  ["Parasite (2019)", "movie", has("parasite", "2019")],
  ["The Matrix (1999)", "movie", has("matrix", "1999")],
  ["Arrival (2016 film)", "movie", has("arrival", "2016")],
  ["Avatar (2009)", "movie", has("avatar", "2009")],
  ["Interstellar (Christopher Nolan)", "movie", starts("Interstellar")],
  ["Dune (Denis Villeneuve)", "movie", starts("Dune")],
  // subtitles: the note is part of the title
  ["Star Wars (The Empire Strikes Back)", "movie", has("empire strikes back")],
  ["Star Wars (Return of the Jedi)", "movie", has("return of the jedi")],
  ["Harry Potter (Prisoner of Azkaban)", "movie", has("azkaban")],
  ["Lord of the Rings (Return of the King)", "movie", has("return of the king")],
  ["Dune (Part Two)", "movie", has("part two")],
  ["Dune (Part One)", "movie", has("dune", "2021")],
  ["The Godfather (Part II)", "movie", has("godfather", "ii")],
  ["The Godfather (Part I)", "movie", (l) => /godfather/i.test(l) && /1972/.test(l)],
  ["Star Trek (The Original Series)", "tv_show", (l) => /^star trek( \(|$)/i.test(l)],
  ["Star Trek (The Next Generation)", "tv_show", has("next generation")],
  ["Parts Unknown (Anthony Bourdain)", "tv_show", has("parts unknown")],
  ["No Reservations (Anthony Bourdain)", "tv_show", has("no reservations")],
  // another name for it
  ["Yasiin Bey (Mos Def)", "artist", (l) => /^(mos def|yasiin bey)( \(|$)/i.test(l) && !/marvin/i.test(l)],
  ["Mos Def (Yasiin Bey)", "artist", (l) => /^(mos def|yasiin bey)( \(|$)/i.test(l) && !/marvin/i.test(l)],
  ["Ye (Kanye West)", "artist", (l) => /^(kanye west|ye)( \(|$)/i.test(l)],
  ["Cat Stevens (Yusuf)", "artist", (l) => /^(cat stevens|yusuf)/i.test(l)],
  ["Snoop Lion (Snoop Dogg)", "artist", (l) => /^(snoop dogg|snoop lion)( \(|$)/i.test(l)],
  ["La Casa de Papel (Money Heist)", "tv_show", (l) => /money heist|casa de papel/i.test(l)],
  // nothing real
  ["Moonsprout (indie rock band)", "artist", none],
  ["Nobody Real Qzx (TV series)", "tv_show", none],
  // names that end in brackets themselves
  ["Birdman (or The Unexpected Virtue of Ignorance)", "movie", starts("Birdman")],
];
