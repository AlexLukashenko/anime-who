// Service worker: загрузка данных (Shikimori, AniList, Jimaku), разбор субтитров,
// хранение сдвигов, связь между вкладкой, плеером и offscreen-документом (VAD).

import { parseSubtitle, speechIntervals } from './lib/subs.js';
import { buildMatcher, findMentions } from './lib/names.js';
import { pickCandidates, subtitleLabel } from './lib/episodes.js';
import { SETTINGS_DEFAULTS } from './lib/settings.js';
import { cleanDescription, relatedCharacters } from './lib/desc.js';
import { parseAnimeRef } from './lib/refs.js';
import { pickPrune } from './lib/cache.js';
import { matchAnilist } from './lib/match.js';

const SHIKI = 'https://shikimori.io';
const JIMAKU = 'https://jimaku.cc';
const CLIENT_ID = 'kto-eto-anime-extension/0.1';
const DATA_VERSION = 2; // поменять, если изменится формат подготовленных данных (2 — персонажи прошлых сезонов)

// ---------- утилиты ----------

async function getSettings() {
  const s = await chrome.storage.sync.get(SETTINGS_DEFAULTS);
  return { ...SETTINGS_DEFAULTS, ...s };
}

async function cacheGet(key, ttlMs) {
  const r = await chrome.storage.local.get(key);
  const item = r[key];
  if (!item) return null;
  if (ttlMs && Date.now() - item.at > ttlMs) return null;
  return item.value;
}

async function cacheSet(key, value) {
  await chrome.storage.local.set({ [key]: { at: Date.now(), value } });
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// ---------- Shikimori ----------

const SHIKI_QUERY = `query($ids: String!) {
  animes(ids: $ids, limit: 1) {
    id malId name russian japanese english synonyms episodes episodesAired kind
    related { relationKind anime { id malId } }
    characterRoles { rolesEn character { id name russian japanese synonyms description poster { previewUrl mainUrl } } }
  }
}`;

async function loadShikimori(malId) {
  const key = `shiki3:${malId}`; // 2 — с описаниями, 3 — со ссылками на приквелы
  const cached = await cacheGet(key, 7 * DAY);
  if (cached) return cached;
  const res = await fetchWithTimeout(`${SHIKI}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: SHIKI_QUERY, variables: { ids: String(malId) } }),
  });
  const json = await res.json();
  const a = json?.data?.animes?.[0];
  if (!a) throw new Error('Shikimori не вернул тайтл');
  const characters = (a.characterRoles || [])
    .filter((r) => r.character)
    .map((r) => ({
      id: Number(r.character.id),
      name: r.character.name,
      russian: r.character.russian,
      japanese: r.character.japanese,
      synonyms: (r.character.synonyms || []).map((s) => s.trim()).filter(Boolean),
      role: (r.rolesEn || []).includes('Main') ? 'main' : 'supporting',
      img: r.character.poster?.previewUrl || r.character.poster?.mainUrl || null,
      desc: cleanDescription(r.character.description),
    }));
  const value = {
    malId: Number(a.malId || malId),
    name: a.name,
    russian: a.russian,
    japanese: a.japanese,
    english: a.english,
    synonyms: a.synonyms || [],
    episodes: a.episodes || 0,
    episodesAired: a.episodesAired || 0,
    kind: a.kind,
    prequels: (a.related || []).filter((r) => r.relationKind === 'prequel' && r.anime)
      .map((r) => Number(r.anime.malId || r.anime.id)),
    characters,
  };
  await cacheSet(key, value);
  return value;
}

const SEARCH_QUERY = `query($q: String!) {
  animes(search: $q, limit: 8) { id malId name russian japanese english kind }
}`;

/** Поиск аниме по названию со страницы (для сайтов без ссылки на Shikimori/MAL). */
async function searchShikimori(title) {
  const q = (title || '').trim();
  if (q.length < 2) return null;
  const key = `search:${q.toLowerCase()}`;
  const cached = await cacheGet(key, 7 * DAY);
  if (cached !== null) return cached || null;
  const res = await fetchWithTimeout(`${SHIKI}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { q } }),
  });
  const list = (await res.json())?.data?.animes || [];
  const norm = (x) => (x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const nq = norm(q);
  const exact = list.find((a) => [a.russian, a.name, a.english, a.japanese].some((n) => norm(n) === nq));
  const hit = exact || list[0] || null;
  const value = hit ? { malId: Number(hit.malId || hit.id), title: hit.russian || hit.name } : false;
  await cacheSet(key, value);
  return value || null;
}

/** Серия: ручной выбор → API YummyAnime → адрес плеера → страница → событие Kodik → 1. */
function chooseEpisode(info, playerEpisode) {
  if (info.override?.episode) return { episode: info.override.episode, source: 'manual' };
  if (info.site === 'yummyani' && info.topEpisode) return { episode: info.topEpisode, source: 'site' };
  if (playerEpisode) return { episode: playerEpisode, source: 'player' };
  if (info.topEpisode) return { episode: info.topEpisode, source: 'page' };
  if (info.kodikEpisode) return { episode: info.kodikEpisode, source: 'kodik' };
  return { episode: 1, source: 'default' };
}

function pageKey(url) {
  try { const u = new URL(url); return `${u.hostname}${u.pathname}`; } catch { return null; }
}

// ---------- AniList (ID для Jimaku + альтернативные японские имена) ----------

const ANILIST_QUERY = `query($mal: Int, $page: Int) {
  Media(idMal: $mal, type: ANIME) {
    id episodes title { romaji english native }
    characters(page: $page, perPage: 25, sort: [ROLE, RELEVANCE]) {
      pageInfo { hasNextPage }
      edges { role voiceActors(language: JAPANESE, sort: [RELEVANCE]) { name { full native } } node { id gender name { full native alternative } } }
    }
  }
}`;

async function loadAnilist(malId) {
  const key = `anilist4:${malId}`; // 2 — пол, 3 — японские сэйю, 4 — все страницы персонажей
  const cached = await cacheGet(key, 7 * DAY);
  if (cached) return cached;
  try {
    let m = null;
    const edges = [];
    for (let page = 1; page <= 4; page++) {
      const res = await fetchWithTimeout('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: ANILIST_QUERY, variables: { mal: Number(malId), page } }),
      });
      m = (await res.json())?.data?.Media;
      if (!m) break;
      edges.push(...(m.characters?.edges || []));
      if (!m.characters?.pageInfo?.hasNextPage) break;
    }
    if (!m) return null;
    const value = {
      id: m.id,
      episodes: m.episodes,
      title: m.title,
      characters: edges.map((e) => ({
        id: e.node.id,
        full: e.node.name.full,
        native: e.node.name.native,
        alternative: e.node.name.alternative || [],
        gender: e.node.gender || null,
        seiyu: (e.voiceActors || []).slice(0, 2).map((v) => [v.name.native, v.name.full].filter(Boolean).join(' · ')),
      })),
    };
    await cacheSet(key, value);
    return value;
  } catch (e) {
    console.warn('AniList недоступен', e);
    return null;
  }
}

/** AniList: «Female», «Male», «Non-binary», произвольный текст или null → f | m | null. */
function genderOf(g) {
  const x = String(g || '').toLowerCase();
  if (x === 'female') return 'f';
  if (x === 'male') return 'm';
  return null;
}

/**
 * Персонажи Shikimori + данные AniList (варианты имён, пол, сэйю). anilistPool — персонажи
 * AniList текущего и прошлых сезонов: в списке сезона на AniList бывает меньше персонажей.
 */
function mergeCharacters(shiki, anilistPool) {
  const matched = matchAnilist(shiki.characters, anilistPool || []);
  return shiki.characters.map((c) => {
    const a = matched.get(c.id);
    const altNames = a ? [a.native, ...a.alternative].filter(Boolean) : [];
    return { ...c, altNames, gender: genderOf(a?.gender), seiyu: a?.seiyu || [] };
  });
}

// ---------- прошлые сезоны ----------

/**
 * Персонажи приквелов (до 4 сезонов назад). Возвращает тех, кого нет в текущем
 * сезоне, — с пометкой past, и все ID персонажей прошлых сезонов (для режима без спойлеров).
 */
async function loadPastSeasons(shiki) {
  const seasons = [];
  const visited = new Set([shiki.malId]);
  let queue = [...(shiki.prequels || [])];
  for (let depth = 0; depth < 4 && queue.length; depth++) {
    const next = [];
    for (const malId of queue) {
      if (visited.has(malId)) continue;
      visited.add(malId);
      try {
        const prev = await loadShikimori(malId);
        seasons.push({ shiki: prev, anilist: await loadAnilist(malId) });
        next.push(...(prev.prequels || []));
      } catch (e) {
        console.warn('Не удалось загрузить прошлый сезон', malId, e);
      }
    }
    queue = next;
  }
  return seasons;
}

/**
 * Все персонажи сезона и его приквелов: текущие — как есть, из прошлых — только те,
 * кого нет в текущем (с пометкой past). allPrevIds — ID всех персонажей прошлых сезонов.
 */
async function loadCast(shiki, anilist) {
  const seasons = await loadPastSeasons(shiki);
  const pool = [anilist, ...seasons.map((x) => x.anilist)].flatMap((a) => a?.characters || []);
  const current = mergeCharacters(shiki, pool);
  const currentIds = new Set(current.map((c) => c.id));
  const past = new Map();
  const allPrevIds = new Set();
  for (const { shiki: prev } of seasons) {
    for (const c of mergeCharacters(prev, pool)) {
      allPrevIds.add(c.id);
      if (!currentIds.has(c.id) && !past.has(c.id)) past.set(c.id, { ...c, past: true, season: prev.russian || prev.name });
    }
  }
  return { characters: [...current, ...past.values()], allPrevIds };
}

// ---------- Jimaku ----------

function jimakuHeaders(apiKey) {
  const h = { 'X-Client-Id': CLIENT_ID };
  if (apiKey) h.Authorization = apiKey;
  return h;
}

/** Список записей Jimaku без ключа: главная страница содержит JSON каждой записи. */
async function jimakuIndex() {
  const cached = await cacheGet('jimaku:index', 12 * HOUR);
  if (cached) return cached;
  const res = await fetchWithTimeout(`${JIMAKU}/`, { headers: jimakuHeaders() }, 40000);
  const html = await res.text();
  const out = [];
  const re = /data-extra="([^"]+)"\s*>\s*<a href="\/entry\/(\d+)"/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const e = JSON.parse(decodeEntities(m[1]));
      out.push({ id: Number(m[2]), anilist_id: e.anilist_id ?? null, name: e.name, english_name: e.english_name, japanese_name: e.japanese_name });
    } catch { /* пропускаем битую запись */ }
  }
  if (out.length) await cacheSet('jimaku:index', out);
  return out;
}

async function jimakuFindEntry({ anilistId, names }, apiKey) {
  if (apiKey && anilistId) {
    try {
      const res = await fetchWithTimeout(`${JIMAKU}/api/entries/search?anime=true&anilist_id=${anilistId}`, { headers: jimakuHeaders(apiKey) });
      const list = await res.json();
      if (list?.length) return { id: list[0].id, name: list[0].name };
    } catch (e) {
      console.warn('Jimaku API: поиск не удался, пробуем без ключа', e);
    }
  }
  const index = await jimakuIndex();
  if (anilistId) {
    const hit = index.find((e) => e.anilist_id === anilistId);
    if (hit) return hit;
  }
  const keys = new Set(names.filter(Boolean).map((n) => n.trim().toLowerCase()));
  const hit = index.find((e) => [e.name, e.english_name, e.japanese_name].some((n) => n && keys.has(n.trim().toLowerCase())));
  return hit || null;
}

async function jimakuFiles(entryId, apiKey) {
  const key = `jimaku:files:${entryId}`;
  const cached = await cacheGet(key, 1 * HOUR);
  if (cached) return cached;
  let files = null;
  if (apiKey) {
    try {
      const res = await fetchWithTimeout(`${JIMAKU}/api/entries/${entryId}/files`, { headers: jimakuHeaders(apiKey) });
      files = (await res.json()).map((f) => ({ name: f.name, url: f.url, size: f.size }));
    } catch (e) {
      console.warn('Jimaku API: список файлов не получен, пробуем страницу', e);
    }
  }
  if (!files) {
    const res = await fetchWithTimeout(`${JIMAKU}/entry/${entryId}`, { headers: jimakuHeaders() });
    const html = await res.text();
    files = [];
    for (const m of html.matchAll(/data-extra="([^"]+)"/g)) {
      try {
        const f = JSON.parse(decodeEntities(m[1]));
        if (f.url && f.name) files.push({ name: f.name, url: f.url, size: f.size });
      } catch { /* не файл */ }
    }
  }
  files = files.map((f) => ({ ...f, url: new URL(f.url, JIMAKU).href }));
  await cacheSet(key, files);
  return files;
}

async function downloadText(url) {
  const res = await fetchWithTimeout(url, { headers: jimakuHeaders() });
  const buf = await res.arrayBuffer();
  // Почти всегда UTF-8; иногда UTF-16 (BOM) или Shift-JIS
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('shift_jis').decode(buf); } catch { return utf8; }
}

// ---------- подготовка данных серии ----------

function dubKey(info) {
  // «AniLibria.TV» (Kodik) и «Озвучка AniLibria (8 эп.)» (YummyAnime) → «anilibria»
  const raw = info?.dub || info?.translation?.title || '';
  return raw.toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/озвучка|субтитры|плеер/g, '')
    .replace(/[.\s-]*(tv|тв)\s*$/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, '') || 'unknown';
}

/**
 * Задержка субтитров: сохранённая для этой серии → для этого аниме с этой озвучкой →
 * для этой озвучки вообще → задержка по умолчанию из настроек.
 */
async function loadOffset(malId, episode, dub, settings) {
  const keys = [`off:${malId}:${episode}:${dub}`, `offDub:${malId}:${dub}`, `offDubAny:${dub}`];
  const r = await chrome.storage.local.get(keys);
  if (r[keys[0]]) return { value: r[keys[0]].value, source: 'saved' };
  if (dub !== 'unknown') {
    if (r[keys[1]]) return { value: r[keys[1]].value, source: 'anime-dub' };
    if (r[keys[2]]) return { value: r[keys[2]].value, source: 'dub' };
  }
  return { value: Number(settings?.startDelay) || 0, source: 'default' };
}

async function saveOffset(malId, episode, dub, value, how) {
  const now = Date.now();
  const set = { [`off:${malId}:${episode}:${dub}`]: { at: now, value, how } };
  // И ручная правка, и подбор по звуку запоминаются для озвучки — следующая серия начнётся с них
  if (dub !== 'unknown') {
    set[`offDub:${malId}:${dub}`] = { at: now, value };
    set[`offDubAny:${dub}`] = { at: now, value };
  }
  await chrome.storage.local.set(set);
}

async function prepareSubtitle({ name, text, url }, characters) {
  const { format, events } = parseSubtitle(text, name);
  const matcher = buildMatcher(characters);
  const { mentions, speakers } = findMentions(events, matcher);
  return {
    v: DATA_VERSION,
    subtitle: { name, label: subtitleLabel(name), url: url || null, format, lines: events.length },
    speech: speechIntervals(events),
    mentions,
    speakers,
  };
}

async function buildEpisode(info, episode) {
  const settings = await getSettings();
  const malId = info.malId;
  const shiki = await loadShikimori(malId);
  const anilist = await loadAnilist(malId);
  const { characters } = await loadCast(shiki, anilist);
  const seasonEps = shiki.episodes || shiki.episodesAired || anilist?.episodes || 0;

  const result = {
    anime: { malId, title: shiki.russian || shiki.name, name: shiki.name, japanese: shiki.japanese, episode },
    characters: characters.map((c) => ({
      id: c.id, ru: c.russian || c.name, romaji: c.name, jp: c.japanese, role: c.role, img: c.img, desc: c.desc || '',
      gender: c.gender || null, seiyu: c.seiyu || [], ...(c.past ? { past: true, season: c.season } : {}),
    })),
    candidates: [],
    subtitle: null,
    speech: [],
    mentions: [],
    speakers: [],
    status: 'ok',
    message: '',
  };

  const choiceKey = `subChoice:${malId}:${episode}`;
  const customKey = `subCustom:${malId}:${episode}`;
  const stored = await chrome.storage.local.get([choiceKey, customKey]);
  const choice = stored[choiceKey]?.value || null;

  let entry = null;
  try {
    entry = await jimakuFindEntry({
      anilistId: anilist?.id,
      names: [shiki.name, shiki.japanese, shiki.english, anilist?.title?.romaji, anilist?.title?.native, anilist?.title?.english],
    }, settings.jimakuKey);
    if (entry) {
      const files = await jimakuFiles(entry.id, settings.jimakuKey);
      result.candidates = pickCandidates(files, episode, seasonEps).map((f) => ({ name: f.name, url: f.url, score: f.score }));
      result.jimaku = { id: entry.id, name: entry.name };
    }
  } catch (e) {
    console.warn('Jimaku недоступен', e);
    result.message = `Jimaku недоступен: ${e.message}`;
  }

  // Пользователь загрузил свой файл
  if (choice === 'custom' && stored[customKey]?.value) {
    const custom = stored[customKey].value;
    Object.assign(result, await prepareSubtitle({ name: custom.name, text: custom.text }, characters));
    result.subtitle.custom = true;
    result.subtitle.label = 'свой файл';
    return result;
  }

  const order = choice ? [result.candidates.find((c) => c.url === choice), ...result.candidates.filter((c) => c.url !== choice)].filter(Boolean) : result.candidates;
  for (const cand of order.slice(0, 4)) {
    const cacheKey = `ep:${malId}:${episode}:${cand.url}`;
    let prepared = await cacheGet(cacheKey, 30 * DAY);
    if (prepared && prepared.v !== DATA_VERSION) prepared = null;
    if (!prepared) {
      try {
        const text = await downloadText(cand.url);
        prepared = await prepareSubtitle({ name: cand.name, text, url: cand.url }, characters);
        if (prepared.speech.length < 20) continue; // файл пустой или это не реплики
        await cacheSet(cacheKey, prepared);
      } catch (e) {
        console.warn('Не удалось скачать субтитры', cand.url, e);
        continue;
      }
    }
    Object.assign(result, prepared);
    return result;
  }
  result.status = 'no-subs';
  result.message = entry
    ? `На Jimaku нет японских субтитров для ${episode}-й серии. Можно загрузить свой файл в окне расширения.`
    : 'Этого аниме нет на Jimaku. Можно загрузить свой файл субтитров в окне расширения.';
  return result;
}

// ---------- режим без спойлеров: кого зритель уже видел ----------

async function pool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

/**
 * «Знакомые» персонажи к началу серии: все из прошлых сезонов и все, кого называли
 * в субтитрах прошлых серий этого сезона. Кого называют в текущей серии, плеер добавляет сам.
 */
async function knownCharacters(malId, episode) {
  const settings = await getSettings();
  const shiki = await loadShikimori(malId);
  const anilist = await loadAnilist(malId);
  const cast = await loadCast(shiki, anilist);
  const known = new Set(cast.allPrevIds);
  let checked = 0;
  let missing = 0;
  const prevEpisodes = Array.from({ length: Math.max(0, Math.min(episode - 1, 200)) }, (_, i) => i + 1);
  if (prevEpisodes.length) {
    const { characters } = cast;
    const seasonEps = shiki.episodes || shiki.episodesAired || anilist?.episodes || 0;
    let files = null;
    let matcher = null;
    const filesOnce = async () => {
      if (files) return files;
      const entry = await jimakuFindEntry({
        anilistId: anilist?.id,
        names: [shiki.name, shiki.japanese, shiki.english, anilist?.title?.romaji, anilist?.title?.native, anilist?.title?.english],
      }, settings.jimakuKey).catch(() => null);
      files = entry ? await jimakuFiles(entry.id, settings.jimakuKey).catch(() => []) : [];
      return files;
    };
    await pool(prevEpisodes, 3, async (ep) => {
      const key = `seen:${malId}:${ep}`;
      let ids = await cacheGet(key, 60 * DAY);
      if (!ids) {
        const cand = pickCandidates(await filesOnce(), ep, seasonEps)[0];
        if (!cand) { missing++; return; }
        try {
          const { events } = parseSubtitle(await downloadText(cand.url), cand.name);
          matcher ||= buildMatcher(characters);
          const { mentions, speakers } = findMentions(events, matcher);
          ids = [...new Set([...mentions, ...speakers].map((m) => m.id))];
          await cacheSet(key, ids);
        } catch (e) {
          console.warn('Не удалось проверить серию', ep, e);
          missing++;
          return;
        }
      }
      checked++;
      for (const id of ids) known.add(id);
    });
  }
  return { known: [...known], checked, missing };
}

// ---------- карточка персонажа ----------

async function characterCard(id) {
  const key = `card2:${id}`; // 2 — без сэйю (их берём из AniList)
  const cached = await cacheGet(key, 7 * DAY);
  if (cached) return cached;
  const res = await fetchWithTimeout(`${SHIKI}/api/characters/${Number(id)}`, { headers: { Accept: 'application/json' } });
  const c = await res.json();
  const img = c.image?.original && !/missing/.test(c.image.original) ? new URL(c.image.original, SHIKI).href : null;
  const value = {
    id: Number(id),
    ru: c.russian || c.name,
    romaji: c.name,
    jp: c.japanese,
    img,
    desc: cleanDescription(c.description, 900),
    related: relatedCharacters(c.description).filter((r) => r.id !== Number(id)).slice(0, 12),
  };
  await cacheSet(key, value);
  return value;
}

// ---------- уборка кеша ----------

let lastPrune = 0;
async function pruneCache({ force = false } = {}) {
  if (!force && Date.now() - lastPrune < HOUR) return 0;
  lastPrune = Date.now();
  const all = await chrome.storage.local.get(null);
  const keys = pickPrune(all, Date.now());
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

// ---------- состояние вкладок ----------

async function getTab(tabId) {
  const key = `tab:${tabId}`;
  const r = await chrome.storage.session.get(key);
  return r[key] || {};
}

async function patchTab(tabId, patch) {
  const key = `tab:${tabId}`;
  const cur = await getTab(tabId);
  const next = { ...cur, ...patch };
  await chrome.storage.session.set({ [key]: next });
  return next;
}

async function waitForTopInfo(tabId, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = await getTab(tabId);
    if (t.malId) return t;
    await new Promise((r) => setTimeout(r, 300));
  }
  return getTab(tabId);
}

function sendToPlayer(tabId, msg) {
  chrome.tabs.sendMessage(tabId, { ...msg, target: 'player' }).catch(() => {});
}

// ---------- offscreen (VAD) ----------

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS', 'USER_MEDIA'],
      justification: 'Детектор речи (VAD) для синхронизации субтитров со звуком серии',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function startTabCapture(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tab-capture', tabId, streamId });
  sendToPlayer(tabId, { type: 'tab-capture-started' });
}

// ---------- картинки ----------

const imageCache = new Map();
async function imageDataUrl(url) {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url);
  const res = await fetchWithTimeout(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const type = res.headers.get('content-type') || 'image/webp';
  const dataUrl = `data:${type};base64,${btoa(bin)}`;
  imageCache.set(url, dataUrl);
  if (imageCache.size > 300) imageCache.delete(imageCache.keys().next().value);
  return dataUrl;
}

/** Персонаж для примера баннера в настройках: главный герой, которого чаще всего называют в серии. */
function sampleCharacter(data) {
  const counts = new Map();
  for (const m of data.mentions || []) counts.set(m.id, (counts.get(m.id) || 0) + 1);
  const pool = data.characters.filter((c) => !c.past);
  const best = pool.filter((c) => c.role === 'main').sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0))[0] || pool[0];
  if (!best) return null;
  const token = data.mentions?.find((m) => m.id === best.id)?.token || best.jp || '';
  return { id: best.id, ru: best.ru, jp: best.jp, romaji: best.romaji, role: best.role, img: best.img, desc: best.desc, gender: best.gender, token };
}

// ---------- сообщения ----------

const handlers = {
  async 'page-info'(msg, sender) {
    const tabId = sender.tab.id;
    const cur = await getTab(tabId);
    const patch = {
      site: msg.site,
      url: msg.url,
      pageTitle: msg.title,
      dub: msg.dub || cur.dub,
      topEpisode: msg.episode ?? null,
      player: msg.player || '',
    };
    // Ручной выбор пользователя для этой страницы
    const pk = pageKey(msg.url);
    const ovr = pk ? (await chrome.storage.local.get(`ovr:${pk}`))[`ovr:${pk}`] : null;
    patch.override = ovr || null;
    let malId = ovr?.malId || msg.malId || null;
    let malSource = ovr?.malId ? 'manual' : msg.malId ? 'page' : null;
    if (!malId && msg.title && msg.site !== 'other') {
      try {
        const found = await searchShikimori(msg.title);
        if (found) { malId = found.malId; malSource = 'search'; }
      } catch (e) { console.warn('Поиск на Shikimori не удался', e); }
    }
    patch.autoMalId = ovr?.malId ? (cur.autoMalId ?? msg.malId ?? null) : malId; // что нашлось бы без ручного выбора
    patch.malId = malId;
    patch.malSource = malSource;
    if (cur.malId && cur.malId !== malId) patch.translation = null;
    const next = await patchTab(tabId, patch);
    // Плеер уже загрузил данные, а страница сообщила другое аниме/серию/озвучку
    // (сменили серию без перезагрузки плеера или плеер успел спросить раньше страницы) — перезагружаем.
    const loaded = cur.loaded;
    if (loaded) {
      const expected = chooseEpisode(next, loaded.playerEpisode).episode;
      if (loaded.malId !== malId || loaded.episode !== expected || loaded.dubKey !== dubKey(next)) {
        sendToPlayer(tabId, { type: 'reload' });
      }
    }
    return { ok: true, malId };
  },

  async 'kodik-episode'(msg, sender) {
    const tabId = sender.tab.id;
    const cur = await getTab(tabId);
    const next = await patchTab(tabId, { translation: msg.translation || cur.translation, kodikEpisode: msg.episode ?? cur.kodikEpisode });
    if (msg.episode && cur.kodikEpisode && msg.episode !== cur.kodikEpisode) {
      sendToPlayer(tabId, { type: 'episode-changed', episode: msg.episode });
    }
    return { ok: true, dub: dubKey(next) };
  },

  async 'player-hello'(msg, sender) {
    const tabId = sender.tab.id;
    let info = await waitForTopInfo(tabId);
    if (!info.malId) {
      if (!info.site) return { status: 'no-anime' }; // не страница аниме — молчим
      return { status: 'no-anime', message: 'Не понял, какое это аниме. Укажите его в окне расширения: «Что смотрим» → ссылка на Shikimori.' };
    }
    if (info.site === 'yummyani' && info.topEpisode == null) {
      await new Promise((r) => setTimeout(r, 1500));
      info = await getTab(tabId);
    }
    const { episode, source: episodeSource } = chooseEpisode(info, msg.episode);
    const dub = dubKey(info);
    await patchTab(tabId, {
      playerFrameId: sender.frameId,
      episode,
      episodeSource,
      loaded: { malId: info.malId, episode, dubKey: dub, playerEpisode: msg.episode || null },
    });
    pruneCache().catch((e) => console.warn('Уборка кеша', e));
    try {
      const data = await buildEpisode(info, episode);
      data.dub = dub;
      data.settings = await getSettings();
      data.offset = await loadOffset(info.malId, episode, dub, data.settings);
      await patchTab(tabId, {
        lastStatus: data.status, subtitle: data.subtitle, candidates: data.candidates, title: data.anime.title, dubKey: dub,
        sample: sampleCharacter(data),
      });
      return data;
    } catch (e) {
      console.error(e);
      return { status: 'error', message: `Не удалось загрузить данные: ${e.message}` };
    }
  },

  async 'save-offset'(msg, sender) {
    const tabId = sender.tab?.id ?? msg.tabId;
    const info = await getTab(tabId);
    if (!info.malId) return { ok: false };
    await saveOffset(info.malId, msg.episode || info.episode || 1, dubKey(info), msg.value, msg.how || 'auto');
    await patchTab(tabId, { offset: { value: msg.value, how: msg.how } });
    return { ok: true };
  },

  async image(msg) {
    try { return { dataUrl: await imageDataUrl(msg.url) }; } catch { return { dataUrl: null }; }
  },

  async 'character-card'(msg) {
    try { return { card: await characterCard(msg.id) }; } catch (e) { return { card: null, error: String(e.message || e) }; }
  },

  async 'known-characters'(msg, sender) {
    const info = await getTab(sender.tab?.id ?? msg.tabId);
    if (!info.malId) return { known: null };
    try { return await knownCharacters(info.malId, msg.episode || info.episode || 1); } catch (e) { return { known: null, error: String(e.message || e) }; }
  },

  async 'open-url'(msg, sender) {
    // Открываем только страницы Shikimori — ссылку собирает сам плеер, но проверяем всё равно
    let url;
    try { url = new URL(msg.url); } catch { return { ok: false }; }
    if (url.protocol !== 'https:' || !/^shikimori\.(io|one)$/.test(url.hostname)) return { ok: false };
    const opts = { url: url.href, active: true };
    if (sender.tab) { opts.index = sender.tab.index + 1; opts.openerTabId = sender.tab.id; opts.windowId = sender.tab.windowId; }
    await chrome.tabs.create(opts);
    return { ok: true };
  },

  async 'ensure-offscreen'() {
    await ensureOffscreen();
    return { ok: true };
  },

  async 'need-tab-capture'(msg, sender) {
    await patchTab(sender.tab.id, { needsTabCapture: true });
    return { ok: true };
  },

  async 'sync-status'(msg, sender) {
    await patchTab(sender.tab.id, { sync: msg.sync });
    return { ok: true };
  },

  // ---- из popup ----
  async 'popup-state'(msg) {
    const info = await getTab(msg.tabId);
    const settings = await getSettings();
    return { info, settings, dub: dubKey(info) };
  },

  async 'popup-choose-subtitle'(msg) {
    const info = await getTab(msg.tabId);
    if (!info.malId) return { ok: false };
    await cacheSet(`subChoice:${info.malId}:${info.episode || 1}`, msg.url);
    sendToPlayer(msg.tabId, { type: 'reload' });
    return { ok: true };
  },

  async 'popup-upload-subtitle'(msg) {
    const info = await getTab(msg.tabId);
    if (!info.malId) return { ok: false };
    const ep = info.episode || 1;
    await cacheSet(`subCustom:${info.malId}:${ep}`, { name: msg.name, text: msg.text });
    await cacheSet(`subChoice:${info.malId}:${ep}`, 'custom');
    sendToPlayer(msg.tabId, { type: 'reload' });
    return { ok: true };
  },

  async 'popup-override'(msg) {
    const info = await getTab(msg.tabId);
    const pk = pageKey(info.url);
    if (!pk) return { ok: false, error: 'Нет страницы' };
    const malId = parseAnimeRef(msg.anime);
    if (msg.anime && !malId) return { ok: false, error: 'Не понял ссылку: нужна ссылка на Shikimori/MyAnimeList или число' };
    const episode = Number(msg.episode) > 0 ? Number(msg.episode) : null;
    const key = `ovr:${pk}`;
    if (!malId && !episode) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: { malId, episode } });
    const next = await patchTab(msg.tabId, {
      override: malId || episode ? { malId, episode } : null,
      ...(malId ? { malId, malSource: 'manual' } : { malId: info.autoMalId ?? info.malId, malSource: info.autoMalId ? 'page' : info.malSource }),
    });
    sendToPlayer(msg.tabId, { type: 'reload' });
    return { ok: true, malId: next.malId };
  },

  async 'popup-forward'(msg) {
    sendToPlayer(msg.tabId, msg.payload);
    return { ok: true };
  },

  async 'popup-tab-capture'(msg) {
    // streamId получен в popup (это действие пользователя) — передаём в offscreen
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tab-capture', tabId: msg.tabId, streamId: msg.streamId });
    sendToPlayer(msg.tabId, { type: 'tab-capture-started' });
    return { ok: true };
  },

  async 'clear-cache'() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => /^(shiki\d?|anilist\d?|jimaku|ep|seen|card\d?|search):/.test(k));
    await chrome.storage.local.remove(keys);
    imageCache.clear();
    return { ok: true, removed: keys.length };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen' || msg?.target === 'player') return false;
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg, sender)).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) return;
  if (command === 'toggle-panel') sendToPlayer(tab.id, { type: 'toggle-panel' });
  if (command === 'resync') {
    const info = await getTab(tab.id);
    if (info.needsTabCapture) {
      try { await startTabCapture(tab.id); } catch (e) { console.warn('tabCapture', e); }
    }
    sendToPlayer(tab.id, { type: 'resync' });
  }
});

chrome.runtime.onStartup.addListener(() => { pruneCache({ force: true }).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { pruneCache({ force: true }).catch(() => {}); });

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab:${tabId}`);
});
