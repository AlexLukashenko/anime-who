// Уборка кеша в chrome.storage.local: устаревшие ответы API и подготовленные серии.
// Пользовательские данные (задержки, ручной выбор, выключенные персонажи, свои субтитры) не трогаем.

const DAY = 24 * 3600e3;

// Префикс ключа → сколько хранить. Порядок важен: первый подходящий.
export const CACHE_RULES = [
  ['jimaku:', 3 * DAY],
  ['ep:', 60 * DAY],
  ['seen:', 60 * DAY],
  ['card', 30 * DAY],
  ['shiki', 30 * DAY],
  ['anilist', 30 * DAY],
  ['search:', 30 * DAY],
];

export function cacheRule(key) {
  return CACHE_RULES.find(([p]) => key.startsWith(p)) || null;
}

/**
 * Какие ключи удалить: всё старше срока, а если кеш всё равно больше maxBytes —
 * самые старые записи кеша, пока не уложимся.
 */
export function pickPrune(all, now, { maxBytes = 40 * 1024 * 1024 } = {}) {
  const entries = [];
  let total = 0;
  for (const [key, item] of Object.entries(all)) {
    const size = key.length + JSON.stringify(item ?? null).length;
    total += size;
    const rule = cacheRule(key);
    if (!rule) continue;
    entries.push({ key, size, at: Number(item?.at) || 0, maxAge: rule[1] });
  }
  const remove = new Set();
  for (const e of entries) {
    if (now - e.at > e.maxAge) { remove.add(e.key); total -= e.size; }
  }
  if (total > maxBytes) {
    for (const e of entries.filter((x) => !remove.has(x.key)).sort((a, b) => a.at - b.at)) {
      if (total <= maxBytes) break;
      remove.add(e.key);
      total -= e.size;
    }
  }
  return [...remove];
}
