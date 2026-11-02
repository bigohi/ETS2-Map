// French names of the game's countries (keys: token and English name).
const FR = {
  iceland: 'Islande', albania: 'Albanie', austria: 'Autriche', belgium: 'Belgique', bosnia: 'Bosnie-Herzégovine',
  bulgaria: 'Bulgarie', croatia: 'Croatie', czech: 'Tchéquie', denmark: 'Danemark', estonia: 'Estonie',
  finland: 'Finlande', france: 'France', germany: 'Allemagne', greece: 'Grèce', hungary: 'Hongrie', italy: 'Italie',
  kosovo: 'Kosovo', latvia: 'Lettonie', lithuania: 'Lituanie', luxembourg: 'Luxembourg', macedonia: 'Macédoine du Nord',
  montenegro: 'Monténégro', netherlands: 'Pays-Bas', norway: 'Norvège', poland: 'Pologne', portugal: 'Portugal',
  romania: 'Roumanie', russia: 'Russie', serbia: 'Serbie', slovakia: 'Slovaquie', slovenia: 'Slovénie', spain: 'Espagne',
  sweden: 'Suède', switzerland: 'Suisse', turkey: 'Turquie', uk: 'Royaume-Uni',
};
const BY_ENGLISH = {
  'Bosnia and Herzegovina': 'bosnia', 'Czech Republic': 'czech', 'North Macedonia': 'macedonia', Türkiye: 'turkey', 'United Kingdom': 'uk',
};

/** French name from a country token ("germany") or English name ("Germany"). */
export function countryFr(tokenOrName) {
  if (!tokenOrName) return '';
  const t = String(tokenOrName);
  return FR[t] ?? FR[BY_ENGLISH[t]] ?? FR[t.toLowerCase()] ?? t;
}
