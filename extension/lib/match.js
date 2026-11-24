// Сверка персонажей Shikimori ↔ AniList. Общего ID у них нет (у персонажей AniList нет MAL ID),
// поэтому сверяем по именам: латиница (Shikimori часто даёт китайское чтение, AniList — японское,
// поэтому одной латиницы мало) и иероглифы — целиком и по частям («漢 羅漢» ↔ «羅漢»).
import { romajiKey } from './names.js';

const normJp = (s) => String(s || '').replace(/[（(][^）)]*[）)]/gu, '').replace(/[\s・･=＝]/gu, '');

function keysOf(latin, native) {
  const keys = [];
  for (const n of latin) {
    const k = romajiKey(n);
    if (k.length >= 3) keys.push(`r:${k}`);
  }
  for (const n of native) {
    if (!n) continue;
    const whole = normJp(n);
    if (whole) keys.push(`j:${whole}`);
    const parts = String(n).replace(/[（(][^）)]*[）)]/gu, '').split(/[\s・･=＝]+/u).filter(Boolean);
    if (parts.length > 1) for (const p of parts) if ([...p].length >= 2) keys.push(`j:${p}`);
  }
  return keys;
}

/**
 * shiki: [{id, name, japanese, synonyms[]}], anilist: [{id, full, native, alternative[], ...}]
 * (персонажи AniList из текущего и прошлых сезонов, можно с повторами).
 * Возвращает Map: id персонажа Shikimori → персонаж AniList. Ключ, общий для разных
 * персонажей AniList, не используется; сначала пробуем полные совпадения, потом по частям имени.
 */
export function matchAnilist(shiki, anilist) {
  const byId = new Map();
  for (const a of anilist) if (a && !byId.has(a.id)) byId.set(a.id, a);
  const owners = new Map();
  for (const a of byId.values()) {
    for (const k of new Set(keysOf([a.full, ...(a.alternative || [])], [a.native, ...(a.alternative || []).filter((x) => /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}]/u.test(x))]))) {
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k).add(a.id);
    }
  }
  const out = new Map();
  for (const c of shiki) {
    for (const k of keysOf([c.name, ...(c.synonyms || [])], [c.japanese])) {
      const ids = owners.get(k);
      if (ids?.size === 1) { out.set(c.id, byId.get([...ids][0])); break; }
    }
  }
  return out;
}
