// Краткое описание персонажа из BBCode Shikimori: без спойлеров, ссылок и тегов.

/** Убирает спойлерные блоки целиком, вместе с содержимым (в т.ч. [spoiler=…], [spoiler_block]). */
export function stripSpoilers(raw) {
  let s = String(raw || '').replace(/\r/g, '');
  for (let i = 0; i < 5 && /\[spoiler/i.test(s); i++) {
    s = s.replace(/\[spoiler[^\]]*\](?:(?!\[spoiler)[\s\S])*?\[\/spoiler[^\]]*\]/gi, ' ');
  }
  return s.replace(/\[spoiler[^\]]*\][\s\S]*$/i, ' '); // незакрытый спойлер — всё до конца
}

const cap = (t) => t.replace(/(^|[\s-])(\p{Ll})/gu, (_m, a, b) => a + b.toUpperCase());

/** Персонажи, на которых ссылается описание (вне спойлеров): [{id, name}] без повторов. */
export function relatedCharacters(raw) {
  const s = stripSpoilers(raw);
  const out = new Map();
  for (const m of s.matchAll(/\[character=(\d+)(?:\s+([^\]]+))?\]([^[]*)(?:\[\/character\])?/gi)) {
    const id = Number(m[1]);
    const name = (m[2] || m[3] || '').trim();
    if (!out.has(id)) out.set(id, { id, name: cap(name) });
  }
  return [...out.values()];
}

export function cleanDescription(raw, maxLen = 220) {
  if (!raw) return '';
  let s = stripSpoilers(raw);
  // [character=123 имя] → имя; [character=123]текст[/character] → текст
  s = s.replace(/\[character=\d+\s+([^\]]+)\]/gi, (_m, name) => cap(name)); // в BBCode имена часто строчными
  s = s.replace(/\[(anime|manga|ranobe|person|people)=\d+\s+([^\]]+)\]/gi, '$2');
  s = s.replace(/\[(character|anime|manga|ranobe|person|people)=\d+\]([\s\S]*?)\[\/\1\]/gi, '$2');
  s = s.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1');
  s = s.replace(/\[source\][\s\S]*?\[\/source\]/gi, ' ');
  s = s.replace(/\[\/?[a-z_]+(?:=[^\]]*)?\]/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  // Обрезаем по концу предложения, если оно не слишком короткое
  const cut = s.slice(0, maxLen);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end > maxLen * 0.45) return cut.slice(0, end + 1);
  return `${cut.replace(/\s+\S*$/, '')}…`;
}
