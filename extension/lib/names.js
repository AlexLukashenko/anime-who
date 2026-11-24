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
`.split(/\s+/).filter(Boolean));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codeLen(s) {
  return [...s].length;
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
  return new Set([...out].filter((v) => codeLen(v) >= 2 && CJK_RE.test(v) && !JP_GENERIC.has(v) && !/[/／]/.test(v)));
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

/**
 * characters: [{id, name, russian, japanese, synonyms[], altNames[]}]
 * Возвращает матчер с регэкспами по трём письменностям.
 */
export function buildMatcher(characters) {
  const owners = { cjk: new Map(), lat: new Map(), cyr: new Map() };
  const add = (map, tok, id) => {
    if (!map.has(tok)) map.set(tok, new Set());
    map.get(tok).add(id);
  };
  for (const ch of characters) {
    const sources = [ch.japanese, ch.name, ch.russian, ...(ch.synonyms || []), ...(ch.altNames || [])]
      .filter(Boolean).map((s) => String(s).trim());
    for (const s of sources) {
      if (CJK_RE.test(s)) for (const v of variantsCjk(s)) add(owners.cjk, v, ch.id);
      if (LATIN_RE.test(s)) for (const v of variantsLatin(s)) add(owners.lat, v, ch.id);
      if (CYR_RE.test(s)) for (const v of variantsCyr(s)) add(owners.cyr, v.toLowerCase(), ch.id);
    }
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
  const cjkAlt = cjkToks.map((t) => (KATAKANA_ONLY_RE.test(t)
    ? `(?<![\\p{Script=Katakana}ー])${escapeRe(t)}(?![\\p{Script=Katakana}ー])`
    : escapeRe(t)));
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
      const id = tokenToId.cjk.get(m[1]);
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
