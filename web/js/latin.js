// The game names Russian, Bulgarian and Greek companies in their own script
// ("ПК Медведь", "Δημητρίου A.E."), whatever the game language: the telemetry
// passes them through as is. Shown in Latin letters on the phone.

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Ukrainian, Belarusian, Serbian, Macedonian letters.
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'ć', ђ: 'đ', џ: 'dž',
  ѓ: 'gj', ќ: 'kj', ѕ: 'dz',
};
const GRK = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l',
  μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f',
  χ: 'ch', ψ: 'ps', ω: 'o',
};
const GRK_PAIRS = { ου: 'ou', αυ: 'av', ευ: 'ev', ηυ: 'iv', γγ: 'ng' };
const GRK_WORD_START = { μπ: 'b', ντ: 'd' };

const FOREIGN = /[Ͱ-ϿЀ-ӿἀ-῿]/;
const GREEK = /[Ͱ-Ͽἀ-῿]/;
const isLetter = (c) => !!c && /\p{L}/u.test(c);
const isUpper = (c) => !!c && c !== c.toLowerCase();
const greekBase = (c) => (c ?? '').toLowerCase().normalize('NFD')[0] ?? ''; // ά -> α

/** True when the text has Cyrillic or Greek letters. */
export function hasForeign(s) {
  return typeof s === 'string' && FOREIGN.test(s);
}

/** Cyrillic and Greek letters to Latin; anything else is left untouched. */
export function latin(s) {
  if (!hasForeign(s)) return s;
  const src = [...s.normalize('NFC')];
  let out = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    const lower = ch.toLowerCase();
    let rep, n = 1;
    if (GREEK.test(ch)) {
      const pair = greekBase(ch) + greekBase(src[i + 1]);
      if (!isLetter(src[i - 1]) && GRK_WORD_START[pair]) { rep = GRK_WORD_START[pair]; n = 2; }
      else if (GRK_PAIRS[pair]) { rep = GRK_PAIRS[pair]; n = 2; }
      else rep = GRK[greekBase(ch)] ?? ch;
    } else if (lower in CYR) {
      const next = (src[i + 1] ?? '').toLowerCase();
      // "-ый" ending: Staryy -> Stary, like the usual spelling of Russian names.
      if (lower === 'ы' && next === 'й' && !isLetter(src[i + 2])) { rep = 'y'; n = 2; }
      else rep = CYR[lower];
    } else {
      out += ch;
      i++;
      continue;
    }
    if (rep && isUpper(ch)) {
      // A word in capitals stays in capitals: "ТТК" -> "TTK", "Жук" -> "Zhuk".
      const caps = isUpper(src[i + n]) || (isUpper(src[i - 1]) && !isLetter(src[i + n]));
      rep = caps ? rep.toUpperCase() : rep[0].toUpperCase() + rep.slice(1);
    }
    out += rep;
    i += n;
  }
  return out;
}
