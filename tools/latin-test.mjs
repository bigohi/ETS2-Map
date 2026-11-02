// Checks web/js/latin.js: game names in Cyrillic or Greek come out in Latin letters.
import assert from 'node:assert/strict';
import { latin, hasForeign } from '../web/js/latin.js';

const cases = [
  ['БЛТ', 'BLT'],
  ['ПК Медведь', 'PK Medved'],
  ['Ладога авто', 'Ladoga avto'],
  ['Зелёные Поля OOO', 'Zelyonye Polya OOO'],
  ['Старый Камень', 'Stary Kamen'],
  ['НС Химия', 'NS Khimiya'],
  ['Финские шины', 'Finskie shiny'],
  ['Стоманена Роза', 'Stomanena Roza'],
  ['Δημητρίου A.E.', 'Dimitriou A.E.'],
  ['Χριστόπουλος Οικοδομικά', 'Christopoulos Oikodomika'],
  ['Saint-Pétersbourg · БЛТ', 'Saint-Pétersbourg · BLT'],
  ['Calais · Bœuf & Cie', 'Calais · Bœuf & Cie'],
];
let fail = 0;
for (const [src, want] of cases) {
  const got = latin(src);
  try { assert.equal(got, want); console.log(`ok   ${src} -> ${got}`); }
  catch { fail++; console.log(`FAIL ${src} -> ${got} (want ${want})`); }
}
for (const v of [undefined, null, '', 42]) assert.equal(latin(v), v);
assert.equal(hasForeign('Paris'), false);
assert.equal(hasForeign('Псков'), true);
console.log(fail ? `${fail} failed` : `all ${cases.length} passed`);
process.exit(fail ? 1 : 0);
