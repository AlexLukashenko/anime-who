// Страница аниме (YummyAnime / DreamCast / Shikimori): какое аниме, какая серия, какая озвучка.
// Сам плеер может быть любым — его обслуживает content/player.js во фрейме с видео.
(() => {
  if (window.top !== window) return;

  const host = location.hostname;
  const SITE = /yummyani\.me$|yummy-anime\.ru$/.test(host) ? 'yummyani'
    : /dreamerscast\.com$/.test(host) ? 'dreamcast'
      : /shikimori\./.test(host) ? 'shikimori' : 'other';

  function send(msg) {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); }
  }

  // ---------- какое аниме ----------

  function findMalId() {
    const links = [...document.querySelectorAll('a[href*="myanimelist.net/anime/"], a[href*="shikimori."][href*="/animes/"]')];
    for (const a of links) {
      const m = a.href.match(/myanimelist\.net\/anime\/(\d+)/) || a.href.match(/\/animes\/[a-z]*(\d+)/);
      if (m) return Number(m[1]);
    }
    const own = location.href.match(/shikimori\.[a-z]+\/animes\/[a-z]*(\d+)/);
    return own ? Number(own[1]) : null;
  }

  /** Название для поиска на Shikimori, если ссылок на базы на странице нет. */
  function findTitle() {
    const raw = document.querySelector('h1')?.textContent
      || document.querySelector('meta[property="og:title"]')?.content
      || document.title;
    return (raw || '')
      .split(/\s[|—–-]\s/)[0]
      .replace(/смотреть( онлайн)?|онлайн|в озвучке.*$|все серии|аниме\b/gi, ' ')
      .replace(/\d+\s*(серия|эпизод)|(серия|эпизод)\s*\d+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---------- какая серия (для сайтов без API) ----------

  function episodeFromUrl() {
    const u = new URL(location.href);
    for (const k of ['episode', 'ep', 'e', 'seria', 'serie', 'series']) {
      const n = Number(u.searchParams.get(k));
      if (Number.isInteger(n) && n > 0) return n;
    }
    const m = u.pathname.match(/(?:episode|ep|seriya|seria|serija)[-_/]?(\d{1,4})(?:\/|$|\.)/i)
      || u.pathname.match(/\/(\d{1,4})[-_](?:seriya|seria|serija|episode)/i)
      || u.hash.match(/^#(?:ep|episode)?(\d{1,4})$/i);
    return m ? Number(m[1]) : null;
  }

  function episodeFromPage() {
    // Активная кнопка серии: «5», «5 серия», «Серия 5»
    const active = [...document.querySelectorAll('[class*="active"], [class*="current"], [class*="selected"], [aria-current], [aria-selected="true"]')];
    for (const el of active) {
      const t = el.textContent.trim();
      const m = t.match(/^(\d{1,4})(\s*(серия|эпизод|ep\.?))?$/i) || t.match(/^(?:серия|эпизод|episode|ep\.?)\s*(\d{1,4})$/i);
      if (m && el.children.length <= 2) return Number(m[1]);
    }
    const heading = [document.querySelector('h1')?.textContent, document.querySelector('h2')?.textContent, document.title].join(' ');
    const m = heading.match(/(\d{1,4})\s*(?:-?я\s*)?(?:серия|эпизод)/i) || heading.match(/(?:серия|эпизод|episode)\s*(\d{1,4})/i);
    return m ? Number(m[1]) : null;
  }

  // ---------- YummyAnime: серия и озвучка текущего плеера из API ----------

  let yummyVideos = null;
  async function loadYummyVideos() {
    if (yummyVideos) return yummyVideos;
    const pageId = document.querySelector('meta[name="page_id"]')?.content;
    if (!pageId) return null;
    try {
      const r = await fetch(`/api/anime/${pageId}/videos`, { credentials: 'include' });
      const j = await r.json();
      yummyVideos = (j.response || []).map((v) => ({
        url: v.iframe_url,
        episode: Number(v.number) || null,
        dub: v.data?.dubbing || '',
        player: v.data?.player || '',
      }));
    } catch { yummyVideos = []; }
    return yummyVideos;
  }

  function parse(u) {
    try { return new URL(u.startsWith('//') ? `https:${u}` : u, location.href); } catch { return null; }
  }

  /** src iframe совпадает с записью API, если совпали хост, путь и все параметры из API. */
  function sameVideo(apiUrl, src) {
    const a = parse(apiUrl);
    const b = parse(src);
    if (!a || !b || a.host !== b.host || a.pathname !== b.pathname) return false;
    for (const [k, v] of a.searchParams) if (b.searchParams.get(k) !== v) return false;
    return true;
  }

  async function currentYummyVideo() {
    const list = await loadYummyVideos();
    if (!list?.length) return null;
    for (const f of document.querySelectorAll('iframe[src]')) {
      const hit = list.find((v) => sameVideo(v.url, f.src));
      if (hit) return { ...hit, src: f.src };
    }
    return null;
  }

  function findDubSelect() {
    const values = [...document.querySelectorAll('[class*="singleValue"]')].map((e) => e.textContent.trim());
    return values.find((v) => /озвучка|субтитры/i.test(v)) || '';
  }

  // ---------- отчёт фону ----------

  let lastSent = '';
  async function report() {
    const malId = findMalId();
    const info = { type: 'page-info', site: SITE, malId, url: location.href, title: findTitle() };
    if (SITE === 'yummyani') {
      const cur = await currentYummyVideo();
      info.dub = cur?.dub || findDubSelect();
      info.episode = cur?.episode ?? null;
      info.player = cur?.player || '';
    } else {
      info.dub = SITE === 'dreamcast' ? 'Dream Cast' : '';
      info.episode = episodeFromUrl() ?? episodeFromPage();
    }
    const sig = JSON.stringify([info.malId, info.title, info.dub, info.episode, info.player, location.pathname]);
    if (sig === lastSent) return;
    lastSent = sig;
    send(info);
  }

  // Kodik шлёт родительской странице события: текущая серия, озвучка.
  window.addEventListener('message', (e) => {
    if (!/kodik|aniqit/.test(e.origin)) return;
    let data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return; }
    }
    if (data?.key === 'kodik_player_current_episode' && data.value) {
      send({
        type: 'kodik-episode',
        episode: data.value.episode || null,
        season: data.value.season || null,
        translation: data.value.translation || null,
      });
    }
  });

  report();
  // Страница дорисовывается (React), плеер и серия меняются без перезагрузки — следим.
  let n = 0;
  const timer = setInterval(() => {
    report();
    if (++n > 40) clearInterval(timer);
  }, 1500);
  let pending = null;
  new MutationObserver((muts) => {
    // Сменился плеер/серия (новый src у iframe) — сообщаем сразу, раньше, чем плеер спросит данные
    if (muts.some((m) => m.type === 'attributes' && m.attributeName === 'src' && m.target.tagName === 'IFRAME')
      || muts.some((m) => [...m.addedNodes].some((n) => n.tagName === 'IFRAME'))) {
      report();
      return;
    }
    if (pending) return;
    pending = setTimeout(() => { pending = null; report(); }, 700);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'class'] });
})();
