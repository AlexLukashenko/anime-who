// Словарь имён персонажей и поиск упоминаний в тексте реплик.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LATIN_RE = /[A-Za-zÀ-ɏ]/;
const CYR_RE = /[Ѐ-ӿ]/;
const KATAKANA_ONLY_RE = /^[\p{Script=Katakana}ー・･]+$/u;
const TITLE_SUFFIX_RE = /[妃様殿姫君]$/u;
const LATIN_STOP = new Set([
  'the', 'of', 'no', 'and', 'von', 'van', 'der', 'de', 'la', 'le', 'el', 'al', 'du', 'da', 'di',
  'san', 'sama', 'kun', 'chan', 'dono', 'mr', 'mrs', 'ms', 'dr', 'sir', 'jr', 'sr',
]);
const RU_STOP = new Set(['фон', 'ван', 'дер', 'де', 'ла', 'ле', 'эль', 'аль', 'сан', 'сама', 'кун', 'тян']);
// Японские нарицательные слова, которые на Shikimori бывают «именами» эпизодических
// персонажей («旦那» — хозяин/муж, «長男» — старший сын). В речи они почти всегда
// не про конкретного персонажа — не ищем по ним.
const JP_GENERIC = new Set(`
旦那 旦那様 若旦那 長男 次男 三男 長女 次女 三女 父 母 父上 母上 父親 母親 父さん 母さん お父さん お母さん
兄 姉 弟 妹 兄さん 姉さん 兄上 姉上 兄貴 姉貴 息子 娘 夫 妻 嫁 婿 祖父 祖母 爺 婆 爺さん 婆さん
おじさん おばさん おじいさん おばあさん 叔父 叔母 伯父 伯母 先生 師匠 主人 ご主人 店主 店長 女将 親方
親分 奥様 奥さん 若様 お嬢様 坊ちゃん 先輩 後輩 地主 商人 交易商 村長 町長 隊長 団長 社長 部長 課長
会長 校長 船長 艦長 将軍 兵士 医者 医官 侍女 女官 宦官 下女 少年 少女 青年 老人 男 女 子供 赤ん坊
客 客人 男性 女性 ナレーション ナレーター 語り手 語り 店員 役人 看守 門番 護衛 番頭 農民 町人 通行人
王 王様 女王 王子 王女 姫 姫様 殿下 陛下 閣下 殿 様 母様 父様 マスター ボス ママ パパ シスター ドクター
キャプテン 高官 見張り役 楼主 主 皆 みんな 彼 彼女 あいつ 俺 私 僕
アナウンサー アナウンス 実況 司会 アイドル
`.split(/\s+/).filter(Boolean));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codeLen(s) {
  return [...s].length;
}

// ---------- хангыль → катакана ----------
// У персонажей корейских тайтлов в поле «японское имя» на Shikimori/AniList часто хангыль,
// а в японских субтитрах те же имена — катаканой (유라 → ユラ, 지슈카 → ジシュカ).

const HANGUL_RE = /[\p{Script=Hangul}]/u;
const H_INIT = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const H_VOW = ['a', 'e', 'ya', 'ye', 'o', 'e', 'yo', 'ye', 'o', 'wa', 'we', 'we', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'u', 'ui', 'i'];
const H_FIN = ['', 'ク', 'ク', 'ク', 'ン', 'ン', 'ン', 'ト', 'ル', 'ル', 'ル', 'ル', 'ル', 'ル', 'ル', 'ル', 'ム', 'プ', 'プ', 'ス', 'ス', 'ン', 'ッ', 'ッ', 'ク', 'ッ', 'プ', ''];
const KANA_ROWS = {
  '': 'アイウエオ', k: 'カキクケコ', g: 'ガギグゲゴ', s: 'サシスセソ', t: 'タチツテト', d: 'ダヂヅデド',
  n: 'ナニヌネノ', h: 'ハヒフヘホ', b: 'バビブベボ', p: 'パピプペポ', m: 'マミムメモ', r: 'ラリルレロ',
};
const VOWEL_IDX = { a: 0, i: 1, u: 2, e: 3, o: 4 };
const SMALL_Y = { a: 'ャ', u: 'ュ', o: 'ョ', e: 'ェ' };
const SMALL_V = { a: 'ァ', i: 'ィ', u: 'ゥ', e: 'ェ', o: 'ォ' };

function kanaSyllable(cons, vowel) {
  const c = { kk: 'k', tt: 't', pp: 'p', ss: 's', jj: 'j' }[cons] ?? cons;
  if (c === 'j' || c === 'ch') {
    const i = c === 'j' ? 'ジ' : 'チ';
    const v = vowel.replace(/^[yw]/, '');
    if (v === 'i') return i;
    if (v === 'ui') return `${i}ュイ`;
    return i + (SMALL_Y[v] || 'ャ');
  }
  if (c === 't' && vowel === 'i') return 'ティ';
  if (c === 'd' && vowel === 'i') return 'ディ';
  if (c === 't' && vowel === 'u') return 'トゥ';
  if (c === 'd' && vowel === 'u') return 'ドゥ';
  const row = KANA_ROWS[c] ?? KANA_ROWS[''];
  if (vowel.length === 1) return row[VOWEL_IDX[vowel]];
  if (vowel === 'ui') return `${row[2]}イ`;
  if (vowel[0] === 'y') {
    if (!c) return vowel === 'ye' ? 'イェ' : 'ヤ_ユ_ヨ'[VOWEL_IDX[vowel[1]]];
    return row[1] + SMALL_Y[vowel[1]];
  }
  // w-гласные
  if (!c) return vowel === 'wa' ? 'ワ' : `ウ${SMALL_V[vowel[1]]}`;
  return row[2] + SMALL_V[vowel[1]];
}

/**
 * Хангыль → катакана по японским правилам записи корейских имён. Возвращает варианты:
 * начальные ㄱ/ㄷ/ㅂ/ㅈ слова пишут то звонко, то глухо (김 → キム, 지 → ジ).
 */
export function hangulToKatakana(s) {
  const words = String(s || '').split(/[\s・･]+/u).filter(Boolean);
  const conv = (word, devoice) => {
    let out = '';
    let first = true;
    for (const ch of word) {
      const code = ch.codePointAt(0) - 0xac00;
      if (code < 0 || code > 11171) { out += ch; first = false; continue; }
      let cons = H_INIT[Math.floor(code / 588)];
      if (first && devoice) cons = { g: 'k', d: 't', b: 'p', j: 'ch' }[cons] ?? cons;
      out += kanaSyllable(cons, H_VOW[Math.floor((code % 588) / 28)]) + H_FIN[code % 28];
      first = false;
    }
    return out;
  };
  const voiced = words.map((w) => conv(w, false));
  const devoiced = words.map((w) => conv(w, true));
  return [...new Set([voiced.join(' '), devoiced.join(' ')])];
}

// ---------- имена из меток говорящих ----------
// В японских [cc]-субтитрах у реплик есть метки «（グリード）». Если метка — катакана, которой
// нет среди имён, но по звучанию она совпадает ровно с одним персонажем (Grid / Greed ↔ グリード,
// Vantner ↔ ベントナー), добавляем её этому персонажу как ещё одно имя.

const KATA_CONS = {};
for (const [cons, row] of Object.entries(KANA_ROWS)) for (const k of row) KATA_CONS[k] = cons;
Object.assign(KATA_CONS, {
  シ: 's', チ: 's', ツ: 's', ジ: 's', ヂ: 's', ヅ: 's', ザ: 's', ズ: 's', ゼ: 's', ゾ: 's',
  フ: 'p', ヴ: 'p', ン: 'n', ヤ: '', ユ: '', ヨ: '', ワ: '', ヲ: '',
});

/**
 * Звучание имени: согласный «скелет» (классы звуков без гласных: «Greed» и «グリード» → «krt»)
 * и цепочка гласных — для выбора, если скелет совпал у нескольких персонажей.
 */
function formsLatin(s) {
  const x = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  const sk = (w) => collapse(w
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/ng/g, 'n').replace(/x/g, 'ks')
    .replace(/sh|ch|tz|ts|[jzc]/g, (m) => (m === 'c' ? 'k' : 's'))
    .replace(/[aeiouyhw]/g, '').replace(/[kgq]/g, 'k').replace(/[td]/g, 't').replace(/[pbfv]/g, 'p').replace(/l/g, 'r'));
  const vw = collapse(x.replace(/[^aeiou]/g, ''));
  // Vantner → ベントナー: конечное r не произносится, Ashur → アシュール — произносится
  return [...new Set([sk(x), sk(x.replace(/r$/, ''))])].map((k) => ({ sk: k, vw }));
}

function formKatakana(s) {
  let sk = '';
  let vw = '';
  for (const k of s) {
    const c = KATA_CONS[k];
    if (c != null) sk += { g: 'k', d: 't', b: 'p', h: '' }[c] ?? c;
    const small = 'ャュョ'.indexOf(k) >= 0 ? 'auo'['ャュョ'.indexOf(k)] : 'ァィゥェォ'.indexOf(k) >= 0 ? 'aiueo'['ァィゥェォ'.indexOf(k)] : null;
    if (small) { vw = vw.slice(0, -1) + small; continue; }
    if (k === 'ヤ' || k === 'ワ') vw += 'a';
    else if (k === 'ユ' || k === 'ヴ') vw += 'u';
    else if (k === 'ヨ' || k === 'ヲ') vw += 'o';
    else for (const row of Object.values(KANA_ROWS)) if (row.includes(k)) { vw += 'aiueo'[row.indexOf(k)]; break; }
    if ('ザジズゼゾ'.includes(k)) vw += 'aiueo'['ザジズゼゾ'.indexOf(k)];
  }
  return { sk: collapse(sk), vw: collapse(vw) };
}

/** Euphemia «eueia» ≈ ユーフェミア «ueia», Ashur «au» = アシュルー «au». */
function vowelsAlike(a, b) {
  return a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)));
}

function collapse(x) {
  return x.replace(/(.)\1+/g, '$1');
}

function nameForms(ch) {
  const out = [];
  const addKata = (k) => {
    out.push(formKatakana(k.replace(/[\s・･]/g, '')));
    for (const p of k.split(/[\s・･]+/)) out.push(formKatakana(p));
  };
  const latin = (s, parts) => {
    const clean = s.replace(/\([^)]*\)/g, '').trim();
    out.push(...formsLatin(clean));
    // По частям — только основное имя: в альтернативных «Blood Witch» часть «Blood» — не имя.
    if (parts) for (const p of clean.split(/[\s'’-]+/)) if (p.length >= 3 && !LATIN_STOP.has(p.toLowerCase())) out.push(...formsLatin(p));
  };
  const sources = [ch.name, ch.japanese, ...(ch.synonyms || []), ...(ch.altNames || [])].filter(Boolean).map(String);
  sources.forEach((s, i) => {
    if (HANGUL_RE.test(s)) for (const k of hangulToKatakana(s)) addKata(k);
    else if (CJK_RE.test(s)) for (const k of s.match(/[\p{Script=Katakana}ー・･]{2,}/gu) || []) addKata(k); // アシュール伯爵 → アシュール
    else if (LATIN_RE.test(s)) latin(s, i === 0);
  });
  return out.filter((f) => f.sk.length >= 2);
}

/**
 * Добавляет персонажам имена-катакану из меток говорящих: если метки нет среди имён, но по
 * звучанию она совпадает ровно с одним персонажем (Grid / Greed ↔ グリード). Возвращает
 * новый список персонажей; исходный не меняется.
 */
export function learnSpeakerNames(events, characters, matcher = buildMatcher(characters)) {
  const labels = new Set();
  for (const ev of events) for (const l of ev.speakers || []) labels.add(l.trim());
  const bySkel = new Map();
  for (const ch of characters) {
    for (const f of nameForms(ch)) {
      if (!bySkel.has(f.sk)) bySkel.set(f.sk, new Map());
      const m = bySkel.get(f.sk);
      if (!m.has(ch.id)) m.set(ch.id, { ch, vws: new Set() });
      m.get(ch.id).vws.add(f.vw);
    }
  }
  const learned = new Map();
  for (const label of labels) {
    if (!KATAKANA_ONLY_RE.test(label) || codeLen(label.replace(/[ー・･]/g, '')) < 2 || JP_GENERIC.has(label)) continue;
    if (matchText(matcher, label).length) continue;
    const { sk, vw } = formKatakana(label);
    if (sk.length < 2 || !bySkel.has(sk)) continue;
    let owners = [...bySkel.get(sk).values()];
    if (owners.some((o) => !o.ch.past)) owners = owners.filter((o) => !o.ch.past);
    // Два согласных — слишком мало (アナウンサー ≈ Niji Ebina): тогда нужны и похожие гласные.
    // Если персонажей несколько — тоже выбираем по гласным.
    if (owners.length > 1 || sk.length < 3) owners = owners.filter((o) => [...o.vws].some((v) => vowelsAlike(v, vw)));
    if (owners.length !== 1) continue;
    const { id } = owners[0].ch;
    if (!learned.has(id)) learned.set(id, []);
    learned.get(id).push(label);
  }
  if (!learned.size) return characters;
  return characters.map((c) => (learned.has(c.id) ? { ...c, altNames: [...(c.altNames || []), ...learned.get(c.id)] } : c));
}

/** Нормализация романизации для сопоставления персонажей Shikimori ↔ AniList. */
export function romajiKey(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
}

function variantsCjk(s) {
  const out = new Set();
  const clean = s.replace(/[（(][^）)]*[）)]/gu, '').trim();
  if (!clean) return out;
  const parts = clean.split(/[\s・･=＝/／]+/u).filter(Boolean);
  out.add(parts.join(''));
  if (parts.length > 1) out.add(clean.replace(/\s+/g, ''));
  for (const p of parts) out.add(p);
  for (const v of [...out]) {
    if (codeLen(v) >= 3 && TITLE_SUFFIX_RE.test(v)) out.add(v.slice(0, -1));
  }
  // Однознаковые имена и фамилии («寿 竜次郎» → 寿, «東») оставляем: в тексте их ищем
  // только отдельным словом (см. SINGLE_HAN_*), иначе 寿 нашёлся бы в 寿司.
  return new Set([...out].filter((v) => (codeLen(v) >= 2 ? CJK_RE.test(v) : SINGLE_HAN_RE.test(v))
    && !JP_GENERIC.has(v) && !/[/／]/.test(v)));
}

const SINGLE_HAN_RE = /^\p{Script=Han}$/u;
// Однознаковое имя — только отдельным словом: слева не иероглиф, не катакана, не латиница и не цифра,
// справа — конец, знак препинания или пробел либо именной суффикс («寿先輩», «東さん»).
const SINGLE_HAN_BEFORE = '(?<![\\p{Script=Han}\\p{Script=Katakana}ー々\\p{Script=Latin}\\p{N}])';
const SINGLE_HAN_AFTER = '(?=$|[^\\p{L}\\p{N}ー々]|さん|くん|君|ちゃん|先輩|様|さま|殿|氏|先生)';

// ---------- прозвища латиницей → катакана ----------
// На Shikimori/AniList прозвища часто только латиницей («Bukki»), а в субтитрах — катаканой (ブッキー).

const KANA_TABLE = (() => {
  const t = { a: 'ア', i: 'イ', u: 'ウ', e: 'エ', o: 'オ', shi: 'シ', chi: 'チ', tsu: 'ツ', fu: 'フ', ji: 'ジ', wa: 'ワ', wo: 'ヲ' };
  for (const [c, row] of Object.entries(KANA_ROWS)) if (c) [...'aiueo'].forEach((v, i) => { t[c + v] ??= row[i]; });
  for (const [v, k] of [['a', 'ヤ'], ['u', 'ユ'], ['o', 'ヨ']]) t[`y${v}`] = k;
  for (const [c, i] of [['k', 'キ'], ['g', 'ギ'], ['n', 'ニ'], ['h', 'ヒ'], ['m', 'ミ'], ['r', 'リ'], ['b', 'ビ'], ['p', 'ピ'], ['sh', 'シ'], ['ch', 'チ'], ['j', 'ジ']]) {
    for (const v of 'auo') t[`${c}${c.length === 1 && c !== 'j' ? 'y' : ''}${v}`] = i + SMALL_Y[v];
  }
  for (const v of 'aueo') t[`j${v}`] = `ジ${SMALL_Y[v] || 'ェ'}`;
  t.she = 'シェ'; t.che = 'チェ'; t.je = 'ジェ';
  for (const k of ['si', 'ti', 'tu', 'hu', 'zi', 'di', 'du', 'yi', 'ye', 'wi', 'wu', 'we']) delete t[k];
  return t;
})();
const HONORIFIC_RE = /[-\s](chan|kun|san|sama|senpai|sempai|tan|dono)$/i;

/** «Bukki» → «ブッキ», «Ryuujirou» → «リュージロー»; не романдзи («Cakey», «Greed») → null. */
export function romajiToKatakana(word) {
  const s = String(word || '').toLowerCase().replace(HONORIFIC_RE, '');
  if (!/^[a-z]+$/.test(s)) return null;
  let out = '';
  let lastVowel = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === 'n' && (i + 1 === s.length || !/[aiueoy]/.test(s[i + 1]))) {
      out += 'ン'; lastVowel = ''; i += s[i + 1] === 'n' && !/[aiueoy]/.test(s[i + 2] || '') ? 2 : 1; continue;
    }
    if (c === s[i + 1] && !/[aiueon]/.test(c)) { out += 'ッ'; i += 1; continue; }
    if (c === 't' && s.startsWith('tch', i)) { out += 'ッ'; i += 1; continue; }
    if ('aiueo'.includes(c) && lastVowel && (c === lastVowel || (lastVowel === 'o' && c === 'u'))) {
      out += 'ー'; lastVowel = ''; i += 1; continue;
    }
    let hit = null;
    for (const len of [3, 2, 1]) if (KANA_TABLE[s.slice(i, i + len)]) { hit = s.slice(i, i + len); break; }
    if (!hit) return null;
    out += KANA_TABLE[hit];
    lastVowel = hit[hit.length - 1];
    i += hit.length;
  }
  return codeLen(out.replace(/[ーッ]/g, '')) >= 2 ? out : null;
}

/** Прозвища персонажа катаканой: однословные латинские синонимы, которых нет в основном имени. */
function nicknameKatakana(ch) {
  const own = new Set(String(ch.name || '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const out = new Set();
  for (const s of [...(ch.synonyms || []), ...(ch.altNames || [])]) {
    const w = String(s).trim();
    if (!LATIN_RE.test(w) || /\s/.test(w.replace(HONORIFIC_RE, ''))) continue;
    if (own.has(w.toLowerCase().replace(HONORIFIC_RE, ''))) continue;
    const k = romajiToKatakana(w);
    if (k) out.add(k);
  }
  return out;
}

function variantsLatin(s) {
  const out = new Set();
  const clean = s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (!clean || !LATIN_RE.test(clean)) return out;
  if (clean.length >= 3) out.add(clean);
  const parts = clean.split(/[\s'’]+/);
  if (parts.length > 1) {
    for (const p of parts) {
      if (p.length >= 3 && !LATIN_STOP.has(p.toLowerCase())) out.add(p);
    }
  }
  // «Ah-Duo» → «Ah Duo» и «AhDuo»
  for (const v of [...out]) {
    if (v.includes('-')) { out.add(v.replace(/-/g, ' ')); out.add(v.replace(/-/g, '')); }
  }
  return out;
}

function variantsCyr(s) {
  const out = new Set();
  const clean = s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (!clean || !CYR_RE.test(clean)) return out;
  if (clean.length >= 3) out.add(clean);
  const parts = clean.split(/[\s-]+/);
  if (parts.length > 1) {
    for (const p of parts) if (p.length >= 3 && !RU_STOP.has(p.toLowerCase())) out.add(p);
  }
  return out;
}

/** Основа русского имени для поиска с окончаниями: «Сакура» → «Сакур» (+ до 3 букв). */
function ruStemPattern(word) {
  const w = word.toLowerCase();
  if (w.includes(' ')) return escapeRe(w);
  if (w.length >= 4 && /[аяоеиуыьй]$/.test(w)) return `${escapeRe(w.slice(0, -1))}[а-яё]{0,3}`;
  return `${escapeRe(w)}[а-яё]{0,3}`;
}

/** Ключ имени-катаканы без «ー»: разная запись долгих гласных — одно имя. */
function kataKey(v) {
  if (!KATAKANA_ONLY_RE.test(v)) return v;
  const k = v.replace(/ー/g, '');
  return codeLen(k) >= 2 ? k : v;
}

/**
 * characters: [{id, name, russian, japanese, synonyms[], altNames[], past?}]
 * Возвращает матчер с регэкспами по трём письменностям.
 */
export function buildMatcher(characters) {
  const owners = { cjk: new Map(), lat: new Map(), cyr: new Map() };
  const add = (map, tok, id) => {
    if (!map.has(tok)) map.set(tok, new Set());
    map.get(tok).add(id);
  };
  // Сначала персонажи текущего сезона, потом из прошлых (past: true): имя, занятое
  // персонажем текущего сезона, за прошлым сезоном не закрепляем — иначе оно станет
  // неоднозначным и пропадёт у обоих.
  const current = { cjk: new Set(), lat: new Set(), cyr: new Set() };
  const ordered = [...characters.filter((c) => !c.past), ...characters.filter((c) => c.past)];
  for (const ch of ordered) {
    const sources = [ch.japanese, ch.name, ch.russian, ...(ch.synonyms || []), ...(ch.altNames || [])]
      .filter(Boolean).map((s) => String(s).trim());
    const put = (kind, tok) => {
      if (ch.past && current[kind].has(tok)) return;
      if (!ch.past) current[kind].add(tok);
      add(owners[kind], tok, ch.id);
    };
    for (const s of sources) {
      if (CJK_RE.test(s)) for (const v of variantsCjk(s)) put('cjk', kataKey(v));
      if (HANGUL_RE.test(s)) for (const k of hangulToKatakana(s)) for (const v of variantsCjk(k)) put('cjk', kataKey(v));
      if (LATIN_RE.test(s)) for (const v of variantsLatin(s)) put('lat', v);
      if (CYR_RE.test(s)) for (const v of variantsCyr(s)) put('cyr', v.toLowerCase());
    }
    for (const k of nicknameKatakana(ch)) if (!JP_GENERIC.has(k)) put('cjk', kataKey(k));
  }
  const tokenToId = { cjk: new Map(), lat: new Map(), cyr: new Map() };
  const ambiguous = [];
  for (const kind of Object.keys(owners)) {
    for (const [tok, ids] of owners[kind]) {
      if (ids.size === 1) tokenToId[kind].set(tok, [...ids][0]);
      else ambiguous.push(tok);
    }
  }
  const byLen = (a, b) => codeLen(b) - codeLen(a);
  const cjkToks = [...tokenToId.cjk.keys()].sort(byLen);
  const latToks = [...tokenToId.lat.keys()].sort(byLen);
  const cyrToks = [...tokenToId.cyr.keys()].sort(byLen);
  // Катакану ищем с необязательной «ー» после каждого знака: アイリン ↔ アイリーン.
  const cjkAlt = cjkToks.map((t) => {
    if (KATAKANA_ONLY_RE.test(t)) return `(?<![\\p{Script=Katakana}ー])${[...t].map(escapeRe).join('ー?')}ー?(?![\\p{Script=Katakana}ー])`;
    if (SINGLE_HAN_RE.test(t)) return `${SINGLE_HAN_BEFORE}${escapeRe(t)}${SINGLE_HAN_AFTER}`;
    return escapeRe(t);
  });
  const re = {
    cjk: cjkAlt.length ? new RegExp(`(${cjkAlt.join('|')})`, 'gu') : null,
    lat: latToks.length ? new RegExp(`(?<![\\p{L}])(${latToks.map(escapeRe).join('|')})(?![\\p{L}])`, 'gu') : null,
    cyr: cyrToks.length ? new RegExp(`(?<![\\p{L}])(${cyrToks.map(ruStemPattern).join('|')})(?![\\p{L}])`, 'giu') : null,
  };
  // Для кириллицы совпадение может быть с окончанием — ищем владельца по основе.
  const cyrLookup = cyrToks.map((t) => ({ re: new RegExp(`^${ruStemPattern(t)}$`, 'iu'), id: tokenToId.cyr.get(t) }));
  return { re, tokenToId, cyrLookup, ambiguous, tokens: { cjk: cjkToks, lat: latToks, cyr: cyrToks } };
}

/** Возвращает [{id, token}] — уникальные персонажи, упомянутые в тексте. */
export function matchText(matcher, text) {
  if (!text) return [];
  const found = new Map();
  const { re, tokenToId } = matcher;
  if (re.cjk && CJK_RE.test(text)) {
    for (const m of text.matchAll(re.cjk)) {
      const id = tokenToId.cjk.get(m[1]) ?? tokenToId.cjk.get(kataKey(m[1]));
      if (id != null && !found.has(id)) found.set(id, m[1]);
    }
  }
  if (re.lat && LATIN_RE.test(text)) {
    for (const m of text.matchAll(re.lat)) {
      const id = tokenToId.lat.get(m[1]);
      if (id != null && !found.has(id)) found.set(id, m[1]);
    }
  }
  if (re.cyr && CYR_RE.test(text)) {
    for (const m of text.matchAll(re.cyr)) {
      const hit = matcher.cyrLookup.find((x) => x.re.test(m[1]));
      if (hit && !found.has(hit.id)) found.set(hit.id, m[1]);
    }
  }
  return [...found].map(([id, token]) => ({ id, token }));
}

/** Таймлайн упоминаний и говорящих по событиям субтитров. */
export function findMentions(events, matcher) {
  const mentions = [];
  const speakers = [];
  for (const ev of events) {
    if (ev.speech) {
      for (const { id, token } of matchText(matcher, ev.text)) {
        mentions.push({ t: round2(ev.start), e: round2(ev.end), id, token });
      }
    }
    for (const label of ev.speakers || []) {
      for (const { id } of matchText(matcher, label)) {
        speakers.push({ t: round2(ev.start), e: round2(ev.end), id });
      }
    }
  }
  return { mentions, speakers };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
