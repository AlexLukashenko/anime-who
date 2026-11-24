// Внутри плеера (любой фрейм с видео на поддерживаемом сайте): баннеры персонажей,
// панель «Кто есть кто», захват звука видео для синхронизации субтитров.
(() => {
  if (window.__ktoEtoPlayer) return;

  // Скрипт подключён ко всем сайтам, чтобы работать с любым плеером (Kodik, CVH, Alloha,
  // Aksor, VK…), но включается только если сам фрейм или его предки — поддерживаемый сайт.
  const SUPPORTED = /(^|\.)(yummyani\.me|yummy-anime\.ru|dreamerscast\.com|shikimori\.(io|one))$/;
  const hostOf = (o) => { try { return new URL(o).hostname; } catch { return ''; } };
  const ancestors = location.ancestorOrigins ? [...location.ancestorOrigins] : [];
  const known = [location.origin, ...ancestors].some((o) => SUPPORTED.test(hostOf(o)));
  // Если родитель скрыл свой адрес (referrer policy), решает фон по вкладке
  const masked = window.top !== window && ancestors.some((o) => !o || o === 'null');
  if (!known && !masked) return;
  window.__ktoEtoPlayer = true;

  const DEFAULTS = {
    enabled: true,
    showMain: true,
    showSupporting: true,
    showSpeakers: false,
    noSpoilers: false,
    fPhoto: true,
    fRu: true,
    fJp: true,
    fRomaji: false,
    fRole: true,
    fTag: true,
    fToken: false,
    fDesc: false,
    bannerSeconds: 6,
    cooldownSeconds: 180,
    position: 'top-left',
    autoSync: true,
    startDelay: 0,
    jimakuKey: '',
  };
  const PCM_RATE = 16000;
  const SEND_EVERY = 0.5; // секунд звука в одном сообщении

  let settings = { ...DEFAULTS };
  let data = null;
  let loading = false;
  let noAnime = false;
  let connecting = false;
  let video = null;
  // Номер серии из адреса самого плеера (Kodik, Alloha, CVH кладут его в параметры)
  let episode = (() => {
    const q = new URL(location.href).searchParams;
    for (const k of ['episode', 'ep', 'e', 'seria', 'serie', 'series']) {
      const n = Number(q.get(k));
      if (Number.isInteger(n) && n > 0 && n < 5000) return n;
    }
    return null;
  })();

  let offset = null; // время видео = время субтитров + offset
  let offsetHow = null; // default | saved | anime-dub | dub | auto | manual
  let oneShot = false;
  let announcedLock = false; // разовый подбор задержки по звуку (кнопка), когда автоподстройка выключена
  let manualOverride = false;
  let lastSubT = null;
  const lastShown = new Map();
  let muted = new Set();
  const images = new Map();
  let knownIds = null; // режим без спойлеров: ID персонажей, знакомых к началу серии (null — ещё не знаем)
  let knownInfo = null;
  let knownLoading = false;
  let card = null; // открытая карточка персонажа: { id, resume }

  let sync = { state: 'idle', observed: 0, vad: null, est: null };
  let port = null;
  let audio = null; // {ctx, proc, src, stream}
  let tabCaptureMode = false;
  let silentSeconds = 0;
  let heardSound = false;

  // ---------- утилиты ----------

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // расширение перезагрузили
    }
  }

  function fmtOffset(x) {
    if (x == null) return '—';
    const s = x >= 0 ? '+' : '−';
    return `${s}${Math.abs(x).toFixed(1)} с`;
  }

  function roleLabel(role) {
    return role === 'main' ? 'главный персонаж' : 'второстепенный';
  }

  /** Пометка на баннере: род — по данным AniList, если он известен. */
  function tagLabel(kind, c) {
    if (kind === 'speaker') return 'говорит';
    if (c?.gender === 'f') return 'упомянута';
    if (c?.gender === 'm') return 'упомянут';
    return 'упомянут(а)';
  }

  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function charById(id) {
    return data?.byId?.get(id);
  }

  async function imageFor(c) {
    if (!c?.img) return null;
    if (images.has(c.img)) return images.get(c.img);
    const p = send({ type: 'image', url: c.img }).then((r) => r?.dataUrl || null);
    images.set(c.img, p);
    return p;
  }

  // ---------- поиск видео ----------

  function pickVideo() {
    const list = [...document.querySelectorAll('video')];
    if (!list.length) return null;
    return list.reduce((best, v) => ((v.duration || 0) > (best.duration || 0) ? v : best), list[0]);
  }

  function attachVideo(v) {
    if (v === video) return;
    video = v;
    stopCapture();
    ['play', 'playing', 'loadedmetadata', 'durationchange'].forEach((ev) => v.addEventListener(ev, onVideoEvent));
    onVideoEvent();
  }

  function onVideoEvent() {
    if (!video) return;
    if (!data && !loading && !noAnime && (video.duration || 0) > 120) load();
    if (data && !video.paused) {
      ensureAudioSync();
      audio?.ctx?.state === 'suspended' && audio.ctx.resume().catch(() => {});
    }
  }

  setInterval(() => {
    const v = pickVideo();
    if (v && v !== video && (v.duration || 0) >= (video?.duration || 0)) attachVideo(v);
  }, 1000);

  // ---------- загрузка данных ----------

  async function load() {
    loading = true;
    const res = await send({ type: 'player-hello', episode });
    loading = false;
    if (!res) return;
    if (res.status === 'no-anime') {
      noAnime = true; // плеер не на странице аниме — молчим
      if (res.message) toast(res.message, 8000);
      return;
    }
    data = res;
    data.byId = new Map((data.characters || []).map((c) => [c.id, c]));
    data.mentions = (data.mentions || []).slice().sort((a, b) => a.t - b.t);
    data.speakers = (data.speakers || []).slice().sort((a, b) => a.t - b.t);
    settings = { ...DEFAULTS, ...(data.settings || {}) };
    const key = `muted:${data.anime?.malId}`;
    const r = await chrome.storage.local.get(key);
    muted = new Set(r[key] || []);
    offset = data.offset?.value ?? null;
    offsetHow = offset != null ? data.offset.source : null;
    lastSubT = null;
    knownIds = null;
    knownInfo = null;
    ensureUi();
    renderPanel();
    if (settings.noSpoilers) loadKnown();
    if (offset == null) { offset = Number(settings.startDelay) || 0; offsetHow = 'default'; }
    if (data.status !== 'ok') toast(data.message || 'Субтитры не найдены — доступна только панель персонажей (Alt+Shift+C).');
    else toast(`«${data.anime.title}», ${data.anime.episode} серия · задержка субтитров ${fmtOffset(offset)}`, 4000);
    reportSync();
    onVideoEvent();
  }

  function resetAll() {
    stopCapture();
    port?.disconnect();
    port = null;
    data = null;
    offset = null;
    offsetHow = null;
    oneShot = false;
    announcedLock = false;
    manualOverride = false;
    lastSubT = null;
    lastShown.clear();
    knownIds = null;
    knownInfo = null;
    closeCard({ resume: false });
    sync = { state: 'idle', observed: 0, vad: null, est: null };
    tabCaptureMode = false;
    silentSeconds = 0;
    heardSound = false;
    clearBanners();
    renderPanel();
  }

  // ---------- сдвиг ----------

  function setOffset(value, how, { save = true } = {}) {
    const changed = offset == null || Math.abs(value - offset) > 0.05 || how !== offsetHow;
    offset = Math.round(value * 100) / 100;
    offsetHow = how;
    lastSubT = null;
    if (save && changed && how !== 'default') send({ type: 'save-offset', value: offset, how: how === 'manual' ? 'manual' : 'auto', episode: data?.anime?.episode });
    reportSync();
    renderPanel();
  }

  function reportSync() {
    if (!data) return; // фреймы без видео (сама страница, обёртки) состояние не сообщают
    send({ type: 'sync-status', sync: { offset, how: offsetHow, state: sync.state, observed: sync.observed, vad: sync.vad, manual: manualOverride } });
  }

  // ---------- звук и синхронизация ----------

  async function ensureAudioSync() {
    if (!(settings.autoSync || oneShot) || !data?.speech?.length || port || connecting || !video) return;
    connecting = true;
    const ok = await send({ type: 'ensure-offscreen' });
    connecting = false;
    if (!ok || port) return;
    try {
      port = chrome.runtime.connect({ name: 'vad' });
    } catch {
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => { port = null; stopCapture(); });
    port.postMessage({ type: 'init', intervals: data.speech, initialOffset: offset });
    sync.state = 'listening';
    if (!tabCaptureMode) startCapture();
  }

  function onPortMessage(msg) {
    if (msg.type === 'ready') { sync.vad = msg.vad; reportSync(); return; }
    if (msg.type !== 'estimate') return;
    sync.observed = msg.observed;
    sync.est = msg.est;
    sync.state = msg.locked ? 'locked' : 'listening';
    if (msg.accepted != null && !manualOverride) {
      const before = offset;
      setOffset(msg.accepted, 'auto');
      if (!announcedLock && !oneShot) {
        announcedLock = true;
        if (before == null || Math.abs(before - offset) >= 0.5) toast(`Задержка уточнена по звуку: ${fmtOffset(offset)}${before != null ? ` (было ${fmtOffset(before)})` : ''}`, 4000);
      }
      if (oneShot && !settings.autoSync) finishOneShot();
    } else { reportSync(); renderPanel(); }
  }

  /** Тумблер автоподбора выключили — перестаём слушать звук, задержка остаётся как есть. */
  function stopListening() {
    stopCapture();
    try { port?.disconnect(); } catch { /* уже закрыт */ }
    port = null;
    sync.state = 'idle';
    reportSync();
  }

  /** Разовый подбор закончен: перестаём слушать звук. */
  function finishOneShot() {
    oneShot = false;
    stopCapture();
    try { port?.disconnect(); } catch { /* уже закрыт */ }
    port = null;
    sync.state = 'idle';
    toast(`Задержка подобрана по звуку: ${fmtOffset(offset)}`, 4000);
    reportSync();
    renderPanel();
  }

  function startCapture() {
    if (audio || !video) return;
    let stream;
    try {
      stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    } catch (e) {
      console.warn('[Кто это?] captureStream недоступен', e);
      requestTabCapture();
      return;
    }
    const begin = () => {
      if (audio || !stream.getAudioTracks().length) return;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const ratio = ctx.sampleRate / PCM_RATE;
      let pos = 0;
      let pending = [];
      let pendingT0 = null;
      let expectedNext = null;
      const flush = () => {
        if (!pending.length || !port) { pending = []; pendingT0 = null; return; }
        const i16 = new Int16Array(pending.length);
        for (let i = 0; i < pending.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pending[i] * 32767)));
        const bytes = new Uint8Array(i16.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        port.postMessage({ type: 'pcm', t0: pendingT0, data: btoa(bin) });
        pending = [];
        pendingT0 = null;
      };
      proc.onaudioprocess = (e) => {
        if (!video || video.paused || video.seeking || tabCaptureMode) { flush(); expectedNext = null; return; }
        const input = e.inputBuffer.getChannelData(0);
        const dur = input.length / ctx.sampleRate;
        const t0 = video.currentTime - dur;
        // тишина в захвате при включённом звуке → источник «закрыт», нужен tabCapture
        let energy = 0;
        for (let i = 0; i < input.length; i += 8) energy += input[i] * input[i];
        if (energy > 1e-6) heardSound = true;
        else if (!video.muted && video.volume > 0) silentSeconds += dur;
        if (!heardSound && silentSeconds > 15) { requestTabCapture(); return; }
        if (expectedNext != null && Math.abs(t0 - expectedNext) > 0.25) flush();
        expectedNext = t0 + dur;
        // ресемплинг в 16 кГц с усреднением
        if (pendingT0 == null) pendingT0 = t0 + pos / ctx.sampleRate;
        while (pos + ratio <= input.length) {
          const a = Math.max(0, Math.floor(pos));
          const b = Math.min(input.length, Math.floor(pos + ratio));
          let s = 0;
          for (let i = a; i < b; i++) s += input[i];
          pending.push(b > a ? s / (b - a) : input[a]);
          pos += ratio;
        }
        pos -= input.length;
        if (pending.length >= PCM_RATE * SEND_EVERY) flush();
      };
      src.connect(proc);
      proc.connect(ctx.destination); // выход процессора — тишина; звук видео не трогаем
      audio = { ctx, proc, src, stream };
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    };
    stream.addEventListener('addtrack', begin);
    begin();
  }

  function stopCapture() {
    if (!audio) return;
    try { audio.proc.disconnect(); audio.src.disconnect(); } catch { /* уже отключено */ }
    audio.ctx.close().catch(() => {});
    audio = null;
  }

  let tabCaptureRequested = false;
  function requestTabCapture() {
    if (tabCaptureRequested) return;
    tabCaptureRequested = true;
    stopCapture();
    sync.state = 'need-tab-capture';
    send({ type: 'need-tab-capture' });
    toast('Не могу услышать звук плеера напрямую. Нажмите Alt+Shift+S (или «Слушать звук вкладки» в окне расширения), чтобы включить синхронизацию.');
    reportSync();
    renderPanel();
  }

  setInterval(() => {
    if (port && video) port.postMessage({ type: 'tick', v: video.currentTime, wall: Date.now(), paused: video.paused || video.seeking, rate: video.playbackRate });
  }, 500);

  // ---------- расписание баннеров ----------

  function firstAfter(list, t) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  setInterval(() => {
    if (!data || !video || offset == null || !settings.enabled) return;
    const t = video.currentTime - offset;
    if (lastSubT == null || t < lastSubT || t - lastSubT > 2.5 || video.paused) { lastSubT = t; return; }
    const fire = (list, kind) => {
      for (let i = firstAfter(list, lastSubT); i < list.length && list[i].t <= t; i++) showBanner(list[i], kind);
    };
    fire(data.mentions, 'mention');
    if (settings.showSpeakers) fire(data.speakers, 'speaker');
    lastSubT = t;
  }, 200);

  // ---------- интерфейс ----------

  let host = null;
  let root = null;
  let els = {};

  const CSS = `
  :host { all: initial; }
  .wrap { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden;
    font: clamp(11px, 1.25vw, 15px)/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #fff; }
  .stack { position: absolute; top: 12px; display: flex; flex-direction: column; gap: 8px; max-width: min(360px, 60vw); }
  .stack.left { left: 12px; } .stack.right { right: 104px; align-items: flex-end; }
  .banner { display: flex; gap: 10px; align-items: center; padding: 7px 14px 7px 7px; border-radius: 12px;
    background: rgba(14, 14, 20, .84); backdrop-filter: blur(8px); box-shadow: 0 6px 24px rgba(0,0,0,.45);
    border: 1px solid rgba(255,255,255,.08); animation: in .35s ease-out; transition: opacity .4s, transform .4s; }
  .banner.out { opacity: 0; transform: translateY(-6px); }
  .banner img, .ph { width: 3.4em; height: 4.4em; border-radius: 8px; object-fit: cover; flex: none; background: #2a2a35; }
  .name { font-size: 1.15em; font-weight: 700; letter-spacing: .01em; }
  .sub { opacity: .72; font-size: .86em; margin-top: 2px; }
  .token { font-size: .82em; margin-top: 3px; opacity: .85; }
  .desc { font-size: .8em; margin-top: 4px; opacity: .78; line-height: 1.35; max-width: 26em;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .item .desc { -webkit-line-clamp: 3; }
  .item .note { font-size: .75em; opacity: .5; margin-top: 2px; }
  .link { color: inherit; text-decoration: none; cursor: pointer; }
  .link:hover { text-decoration: underline; text-underline-offset: 2px; }
  .link::after { content: ' ↗'; font-weight: 400; opacity: .45; font-size: .85em; }
  .pic { display: block; flex: none; line-height: 0; }
  .pic:hover img, .pic:hover .ph { outline: 2px solid rgba(255,255,255,.35); outline-offset: 1px; }
  .tag { display: inline-block; font-size: .72em; padding: 1px 6px; border-radius: 6px; margin-bottom: 3px;
    background: rgba(255,255,255,.12); text-transform: uppercase; letter-spacing: .04em; }
  .tag.speaker { background: rgba(80,160,255,.28); }
  @keyframes in { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: none; } }
  .toggle { position: absolute; top: 12px; right: 60px; width: 34px; height: 34px; border-radius: 50%;
    background: rgba(14,14,20,.75); border: 1px solid rgba(255,255,255,.15); color: #fff; cursor: pointer;
    pointer-events: auto; display: grid; place-items: center; opacity: 0; transition: opacity .3s; padding: 0; }
  .toggle.show, .toggle:hover { opacity: 1; }
  .toggle svg { width: 18px; height: 18px; fill: currentColor; }
  .panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 48vw); background: rgba(12,12,18,.95);
    pointer-events: auto; display: none; flex-direction: column; border-left: 1px solid rgba(255,255,255,.08); }
  .panel.open { display: flex; }
  .ph-head { padding: 12px 14px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .title { font-weight: 700; font-size: 1.05em; padding-right: 26px; }
  .close { position: absolute; top: 8px; right: 8px; background: none; border: 0; color: #fff; font-size: 20px; cursor: pointer; opacity: .7; }
  .status { font-size: .82em; opacity: .75; margin-top: 6px; line-height: 1.45; }
  .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .btn { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.12); color: #fff; border-radius: 7px;
    padding: 3px 8px; font: inherit; font-size: .82em; cursor: pointer; }
  .btn:hover { background: rgba(255,255,255,.18); }
  .list { overflow: auto; padding: 6px 8px 14px; }
  .section { font-size: .75em; text-transform: uppercase; letter-spacing: .06em; opacity: .55; margin: 10px 6px 4px; }
  .item { display: flex; gap: 9px; align-items: center; padding: 5px 6px; border-radius: 8px; }
  .item:hover { background: rgba(255,255,255,.06); }
  .item img, .item .ph { width: 2.6em; height: 3.4em; }
  .item .meta { flex: 1; min-width: 0; }
  .item .name { font-size: 1em; }
  .item.muted { opacity: .4; }
  .eye { background: none; border: 0; color: #fff; opacity: .5; cursor: pointer; font-size: 1em; padding: 4px; }
  .eye:hover { opacity: 1; }
  .banner { pointer-events: auto; cursor: pointer; }
  .banner:hover { border-color: rgba(255,255,255,.3); }
  .past { font-size: .78em; opacity: .6; margin-top: 2px; }
  .open-card { cursor: pointer; }
  .name.open-card:hover { text-decoration: underline; text-underline-offset: 2px; }
  .ext { color: inherit; opacity: .45; text-decoration: none; font-size: .85em; margin-left: 4px; }
  .ext:hover { opacity: 1; }
  .hidden-note { font-size: .78em; opacity: .55; margin: 10px 6px 0; line-height: 1.4; }
  .card-bg { position: absolute; inset: 0; background: rgba(0,0,0,.55); pointer-events: auto; display: grid; place-items: center; animation: in .2s ease-out; }
  .card { position: relative; width: min(560px, 86%); max-height: 84%; overflow: auto; display: flex; gap: 16px; padding: 16px;
    background: rgba(14,14,20,.97); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.6); }
  .card .big { width: 8.5em; height: 11.5em; border-radius: 10px; object-fit: cover; flex: none; background: #2a2a35; }
  .card .body { flex: 1; min-width: 0; }
  .card .name { font-size: 1.35em; padding-right: 24px; }
  .card .desc { -webkit-line-clamp: unset; display: block; max-width: none; font-size: .86em; margin-top: 8px; }
  .card .seyu { font-size: .8em; opacity: .65; margin-top: 6px; }
  .card .rel { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .card .chip { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.12); color: #fff; border-radius: 999px;
    padding: 2px 10px; font: inherit; font-size: .8em; cursor: pointer; text-decoration: none; }
  .card .chip:hover { background: rgba(255,255,255,.2); }
  .card .foot { margin-top: 12px; font-size: .82em; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .card .warn { opacity: .5; font-size: .9em; }
  .card .close { top: 10px; right: 10px; }
  .toast { position: absolute; left: 50%; bottom: 70px; transform: translateX(-50%); max-width: 70%;
    background: rgba(14,14,20,.9); padding: 8px 14px; border-radius: 10px; font-size: .9em; text-align: center;
    animation: in .3s ease-out; transition: opacity .5s; }
  `;

  const ICON = '<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';

  function ensureUi() {
    if (host) return;
    host = document.createElement('kto-eto-overlay');
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="wrap">
      <div class="stack"></div>
      <button class="toggle" title="Кто есть кто (Alt+Shift+C)">${ICON}</button>
      <div class="panel"><div class="ph-head"><div class="title"></div><button class="close" title="Закрыть">×</button>
        <div class="status"></div><div class="row controls"></div></div><div class="list"></div></div>
    </div>`;
    els = {
      wrap: root.querySelector('.wrap'),
      stack: root.querySelector('.stack'),
      toggle: root.querySelector('.toggle'),
      panel: root.querySelector('.panel'),
      title: root.querySelector('.title'),
      status: root.querySelector('.status'),
      controls: root.querySelector('.controls'),
      list: root.querySelector('.list'),
    };
    els.toggle.addEventListener('click', () => togglePanel());
    root.querySelector('.close').addEventListener('click', () => togglePanel(false));
    els.controls.addEventListener('click', onControl);
    els.list.addEventListener('click', onListClick);
    els.stack.addEventListener('click', (e) => {
      const b = e.target.closest('.banner[data-id]');
      if (b) openCard(Number(b.dataset.id));
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && card) { e.stopPropagation(); closeCard(); } }, true);
    placeHost();
    applyPosition();
    let hideTimer = null;
    document.addEventListener('mousemove', () => {
      els.toggle.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => els.toggle.classList.remove('show'), 2500);
    }, true);
    document.addEventListener('fullscreenchange', placeHost);
    document.addEventListener('webkitfullscreenchange', placeHost);
  }

  function placeHost() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    layoutOverlay();
  }

  /**
   * Оверлей — поверх самого видео. В iframe плеера видео занимает весь фрейм,
   * а на сайтах, где видео встроено в страницу (DreamCast), — только его прямоугольник.
   */
  function layoutOverlay() {
    if (!els.wrap || !video) return;
    const st = els.wrap.style;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const r = video.getBoundingClientRect();
    const full = fs || (r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) || r.width < 40 || r.height < 40;
    const box = full ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : r;
    const next = `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`;
    if (st.getPropertyValue('--box') === next) return;
    st.setProperty('--box', next);
    if (full) {
      st.inset = '0';
      st.left = st.top = st.width = st.height = '';
    } else {
      st.inset = 'auto';
      st.left = `${box.left}px`;
      st.top = `${box.top}px`;
      st.width = `${box.width}px`;
      st.height = `${box.height}px`;
    }
  }

  let layoutQueued = false;
  const queueLayout = () => {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layoutOverlay(); });
  };
  addEventListener('scroll', queueLayout, { capture: true, passive: true });
  addEventListener('resize', queueLayout, { passive: true });
  setInterval(layoutOverlay, 1000);

  function applyPosition() {
    if (!els.stack) return;
    els.stack.classList.toggle('left', settings.position !== 'top-right');
    els.stack.classList.toggle('right', settings.position === 'top-right');
  }

  function clearBanners() {
    if (els.stack) els.stack.innerHTML = '';
  }

  function toast(text, ms = 7000) {
    ensureUi();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    els.wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 600); }, ms);
  }

  /** Кого показывать: фильтры по роли из вкладки «Настройки». */
  function roleAllowed(c) {
    return c.role === 'main' ? settings.showMain : settings.showSupporting;
  }

  /** Имя и подпись по чек-листу полей; хотя бы одно имя показываем всегда. */
  function nameParts(c) {
    const names = [];
    if (settings.fRu && c.ru) names.push(c.ru);
    if (settings.fJp && c.jp) names.push(c.jp);
    if (settings.fRomaji && c.romaji && c.romaji !== c.ru) names.push(c.romaji);
    if (!names.length) names.push(c.ru || c.romaji || c.jp);
    const [primary, ...rest] = names;
    const sub = [...rest, settings.fRole ? roleLabel(c.role) : null].filter(Boolean).join(' · ');
    return { primary, sub, past: c.past ? `из прошлых сезонов${c.season ? ` · ${c.season}` : ''}` : '' };
  }

  async function showBanner(ev, kind) {
    const c = charById(ev.id);
    if (!c || muted.has(c.id) || !roleAllowed(c)) return;
    const v = video.currentTime;
    const key = `${kind}:${c.id}`;
    const prev = lastShown.get(key);
    const cooldown = kind === 'speaker' ? Math.max(30, settings.cooldownSeconds / 2) : settings.cooldownSeconds;
    if (prev != null && Math.abs(v - prev) < cooldown) return;
    lastShown.set(key, v);
    ensureUi();
    const { primary, sub, past } = nameParts(c);
    const el = document.createElement('div');
    el.className = 'banner';
    el.dataset.id = c.id;
    el.title = 'Подробнее о персонаже (видео встанет на паузу)';
    el.innerHTML = `${settings.fPhoto ? '<div class="ph"></div>' : ''}<div class="text">
      ${settings.fTag ? `<div class="tag ${kind}"></div>` : ''}<div class="name"></div>
      ${sub ? '<div class="sub"></div>' : ''}${past ? '<div class="past"></div>' : ''}
      ${settings.fToken && ev.token ? '<div class="token"></div>' : ''}
      ${settings.fDesc && c.desc ? '<div class="desc"></div>' : ''}</div>`;
    const set = (sel, text) => { const n = el.querySelector(sel); if (n) n.textContent = text; };
    set('.tag', tagLabel(kind, c));
    set('.name', primary);
    set('.sub', sub);
    set('.past', past);
    set('.token', `в реплике: «${ev.token}»`);
    set('.desc', c.desc);
    els.stack.appendChild(el);
    while (els.stack.children.length > 3) els.stack.firstChild.remove();
    if (settings.fPhoto) {
      imageFor(c).then((url) => {
        if (!url) return;
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        el.querySelector('.ph')?.replaceWith(img);
      });
    }
    const ms = (settings.bannerSeconds + (settings.fDesc && c.desc ? 3 : 0)) * 1000;
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 450);
    }, ms);
  }


  function togglePanel(force) {
    ensureUi();
    const open = force ?? !els.panel.classList.contains('open');
    els.panel.classList.toggle('open', open);
    if (open) renderPanel();
  }

  function statusText() {
    if (!data) return 'Загружаю данные…';
    const parts = [];
    if (data.subtitle) {
      const label = data.subtitle.custom ? 'свой файл' : `Jimaku · ${data.subtitle.label || data.subtitle.format?.toUpperCase() || 'файл'}`;
      parts.push(`Субтитры: <span title="${esc(data.subtitle.name)}">${esc(label)}</span>`);
      parts.push(`Упоминаний в серии: ${data.mentions.length}`);
    } else {
      parts.push(esc(data.message || 'Субтитров нет — баннеры недоступны, панель работает.'));
    }
    if (data.subtitle) {
      const how = {
        default: '— по умолчанию из настроек',
        auto: '— подобрана по звуку ✓',
        manual: '— выставлена вручную',
        saved: '— сохранена для этой серии',
        'anime-dub': '— как в прошлой серии с этой озвучкой',
        dub: '— как у этой озвучки в других аниме',
      }[offsetHow] || '';
      if (offset != null) parts.push(`Задержка субтитров: ${fmtOffset(offset)} ${how}`);
      if (manualOverride && settings.autoSync) parts.push('Ручная правка: автоподбор её не меняет, пока не нажмёте «Подобрать по звуку».');
      if (sync.state === 'need-tab-capture') parts.push('Звук плеера недоступен — нажмите Alt+Shift+S.');
      else if ((settings.autoSync || oneShot) && sync.state === 'listening') parts.push(`Слушаю звук… ${sync.observed ? `(${sync.observed} с)` : ''}`);
    }
    return parts.join('<br>');
  }

  function renderPanel({ soft = false } = {}) {
    if (!els.panel || !els.panel.classList.contains('open')) return;
    // Плановое обновление не трогает список, пока над ним курсор — иначе можно «потерять» клик по ссылке
    const hovering = soft && els.list.matches(':hover');
    els.title.textContent = data?.anime ? `${data.anime.title} — ${data.anime.episode} серия` : 'Кто это?';
    els.status.innerHTML = statusText();
    els.controls.innerHTML = data?.subtitle
      ? `<button class="btn" data-d="-5">−5 с</button><button class="btn" data-d="-0.5">−0.5</button>
         <button class="btn" data-d="0.5">+0.5</button><button class="btn" data-d="5">+5 с</button>
         <button class="btn" data-act="resync" title="Слушает звук около минуты (Alt+Shift+S)">Подобрать по звуку</button>`
      : '';
    if (hovering) return;
    if (!data?.characters?.length) { els.list.innerHTML = ''; return; }
    const now = video && offset != null ? video.currentTime - offset : null;
    const seen = new Map();
    if (now != null) for (const m of data.mentions) { if (m.t <= now) seen.set(m.id, m.t); else break; }
    const recent = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => charById(id)).filter(Boolean);
    // Персонажи прошлых сезонов — только если их назвали в этой серии
    let rest = data.characters.filter((c) => !seen.has(c.id) && !c.past).sort((a, b) => (a.role === b.role ? 0 : a.role === 'main' ? -1 : 1));
    let hiddenNote = '';
    if (settings.noSpoilers) {
      if (!knownIds) {
        hiddenNote = knownLoading || !knownInfo ? 'Без спойлеров: проверяю прошлые серии…' : 'Без спойлеров: не удалось проверить прошлые серии.';
        rest = [];
      } else {
        const before = rest.length;
        rest = rest.filter((c) => knownIds.has(c.id));
        const hidden = before - rest.length;
        if (hidden) hiddenNote = `Без спойлеров: скрыто ${hidden} — их ещё не называли ни в этой серии, ни раньше.`;
        if (knownInfo?.missing) hiddenNote += `${hiddenNote ? ' ' : 'Без спойлеров: '}Для ${knownInfo.missing} прошлых серий нет субтитров, их персонажи могут быть скрыты.`;
      }
    }
    const item = (c) => `<div class="item ${muted.has(c.id) ? 'muted' : ''} ${roleAllowed(c) ? '' : 'hidden-role'}" data-id="${c.id}">
        ${settings.fPhoto ? `<a class="pic open-card" data-card="${c.id}" title="Подробнее"><div class="ph" data-img="${c.id}"></div></a>` : ''}
        <div class="meta"><span class="name open-card" data-card="${c.id}" title="Подробнее"></span><a class="ext" data-open="${shikiUrl(c)}" href="${shikiUrl(c)}" target="_blank" rel="noopener noreferrer" title="Открыть на Shikimori в новой вкладке">↗</a>
          <div class="sub"></div>${c.past ? '<div class="past"></div>' : ''}${settings.fDesc && c.desc ? '<div class="desc"></div>' : ''}${roleAllowed(c) ? '' : '<div class="note">не показывается в баннерах</div>'}</div>
        <button class="eye" data-mute="${c.id}" title="${muted.has(c.id) ? 'Снова показывать' : 'Не показывать баннеры'}">${muted.has(c.id) ? '◌' : '◉'}</button></div>`;
    els.list.innerHTML = (recent.length ? `<div class="section">Упоминались в этой серии</div>${recent.map(item).join('')}` : '')
      + (rest.length ? `<div class="section">${recent.length ? 'Остальные' : 'Персонажи'}</div>${rest.map(item).join('')}` : '')
      + (hiddenNote ? `<div class="hidden-note">${esc(hiddenNote)}</div>` : '');
    for (const node of els.list.querySelectorAll('.item')) {
      const c = charById(Number(node.dataset.id));
      const { primary, sub, past } = nameParts(c);
      node.querySelector('.name').textContent = primary;
      node.querySelector('.sub').textContent = sub;
      const pn = node.querySelector('.past');
      if (pn) pn.textContent = past;
      const d = node.querySelector('.desc');
      if (d) d.textContent = c.desc;
      if (settings.fPhoto) imageFor(c).then((url) => {
        const ph = node.querySelector('.ph');
        if (!url || !ph) return;
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        ph.replaceWith(img);
      });
    }
  }

  setInterval(() => renderPanel({ soft: true }), 3000);

  function onControl(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.d) {
      manualOverride = true;
      setOffset((offset ?? 0) + Number(b.dataset.d), 'manual');
    } else if (b.dataset.act === 'resync') {
      resync();
    }
  }

  function shikiUrl(c) {
    return `https://shikimori.io/characters/${Number(c.id)}`;
  }

  async function onListClick(e) {
    const cardLink = e.target.closest('[data-card]');
    if (cardLink) { openCard(Number(cardLink.dataset.card)); return; }
    const link = e.target.closest('[data-open]');
    if (link) {
      // Новая вкладка рядом с текущей — через расширение, чтобы плеер не мог помешать
      e.preventDefault();
      const r = await send({ type: 'open-url', url: link.dataset.open });
      if (!r?.ok) window.open(link.dataset.open, '_blank', 'noopener');
      return;
    }
    const b = e.target.closest('[data-mute]');
    if (!b || !data) return;
    const id = Number(b.dataset.mute);
    if (muted.has(id)) muted.delete(id); else muted.add(id);
    await chrome.storage.local.set({ [`muted:${data.anime.malId}`]: [...muted] });
    renderPanel();
  }

  // ---------- режим без спойлеров ----------

  async function loadKnown() {
    if (knownLoading || !data) return;
    knownLoading = true;
    renderPanel();
    const forData = data;
    const r = await send({ type: 'known-characters', episode: data.anime?.episode });
    knownLoading = false;
    if (data !== forData) return; // пока проверяли, сменилась серия
    knownInfo = r || { known: null };
    knownIds = r?.known ? new Set(r.known) : null;
    renderPanel();
  }

  // ---------- карточка персонажа ----------

  async function openCard(id) {
    const c = charById(id);
    if (!c) return;
    ensureUi();
    const resume = card ? card.resume : !!(video && !video.paused);
    if (video && !video.paused) video.pause();
    closeCard({ resume: false });
    card = { id, resume };
    const { primary, sub, past } = nameParts({ ...c });
    const bg = document.createElement('div');
    bg.className = 'card-bg';
    bg.innerHTML = `<div class="card" role="dialog" aria-label="Персонаж">
      <div class="ph big"></div>
      <div class="body"><button class="close" title="Закрыть (Esc)">×</button>
        <div class="name"></div><div class="sub"></div>${past ? '<div class="past"></div>' : ''}
        <div class="seyu" hidden></div>
        <div class="desc">${c.desc ? '' : 'Загружаю описание…'}</div>
        <div class="rel" hidden></div>
        <div class="foot"><a class="chip" data-open="${shikiUrl(c)}" href="${shikiUrl(c)}" target="_blank" rel="noopener noreferrer">Открыть на Shikimori ↗</a>
          <span class="warn">описание может спойлерить</span></div>
      </div></div>`;
    const q = (sel) => bg.querySelector(sel);
    const others = [c.jp, c.romaji].filter((x) => x && x !== primary);
    q('.name').textContent = primary;
    q('.sub').textContent = [...new Set([...others, roleLabel(c.role)])].join(' · ') || sub;
    if (past) q('.past').textContent = past;
    if (c.desc) q('.desc').textContent = c.desc;
    if (c.seiyu?.length) { q('.seyu').hidden = false; q('.seyu').textContent = `Сэйю: ${c.seiyu.join(', ')}`; }
    bg.addEventListener('click', (e) => {
      if (e.target === bg || e.target.closest('.close')) { closeCard(); return; }
      const rel = e.target.closest('[data-card]');
      if (rel) { openCard(Number(rel.dataset.card)); return; }
      const link = e.target.closest('[data-open]');
      if (link) {
        e.preventDefault();
        send({ type: 'open-url', url: link.dataset.open }).then((r) => { if (!r?.ok) window.open(link.dataset.open, '_blank', 'noopener'); });
      }
    });
    els.wrap.appendChild(bg);
    card.el = bg;
    imageFor(c).then((url) => {
      if (!url || card?.el !== bg) return;
      const img = document.createElement('img');
      img.className = 'big';
      img.src = url;
      img.alt = '';
      q('.ph.big')?.replaceWith(img);
    });
    const r = await send({ type: 'character-card', id });
    if (card?.el !== bg) return;
    q('.card').dataset.loaded = r?.card ? 'ok' : 'error';
    const info = r?.card;
    if (!info) { if (!c.desc) q('.desc').textContent = 'Описание не загрузилось.'; return; }
    if (info.img) {
      send({ type: 'image', url: info.img }).then((x) => {
        const big = q('.big');
        if (!x?.dataUrl || card?.el !== bg || !big) return;
        const img = document.createElement('img');
        img.className = 'big';
        img.src = x.dataUrl;
        img.alt = '';
        big.replaceWith(img);
      });
    }
    if (info.desc) q('.desc').textContent = info.desc;
    else if (!c.desc) q('.desc').textContent = 'На Shikimori нет описания.';

    if (info.related?.length) {
      const relEl = q('.rel');
      relEl.hidden = false;
      relEl.innerHTML = info.related.map((x) => {
        const inData = charById(x.id);
        const name = esc(inData ? nameParts(inData).primary : x.name || `#${x.id}`);
        return inData
          ? `<button class="chip" data-card="${x.id}">${name}</button>`
          : `<a class="chip" data-open="https://shikimori.io/characters/${x.id}" href="https://shikimori.io/characters/${x.id}" target="_blank" rel="noopener noreferrer">${name} ↗</a>`;
      }).join('');
    }
  }

  function closeCard({ resume = true } = {}) {
    if (!card) return;
    card.el?.remove();
    const shouldResume = resume && card.resume;
    card = null;
    if (shouldResume && video?.paused) video.play().catch(() => {});
  }

  function resync() {
    manualOverride = false;
    if (!settings.autoSync) oneShot = true;
    sync.state = 'listening';
    sync.observed = 0;
    if (port) port.postMessage({ type: 'reset' });
    else ensureAudioSync();
    toast('Слушаю звук, чтобы подобрать задержку — обычно около минуты. Баннеры пока идут с текущей задержкой.', 4000);
    reportSync();
    renderPanel();
  }

  // ---------- сообщения от расширения ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target !== 'player' || !video) return;
    if (!data && msg.type !== 'reload' && msg.type !== 'episode-changed') return; // фрейм без наших данных (реклама и т.п.)
    switch (msg.type) {
      case 'toggle-panel': togglePanel(); break;
      case 'resync': resync(); break;
      case 'reload': resetAll(); noAnime = false; load(); break;
      case 'episode-changed': episode = msg.episode; resetAll(); noAnime = false; load(); break;
      case 'offset-adjust': manualOverride = true; setOffset((offset ?? 0) + msg.delta, 'manual'); break;
      case 'offset-set': manualOverride = true; setOffset(Number(msg.value) || 0, 'manual'); break;
      case 'tab-capture-started':
        tabCaptureMode = true;
        stopCapture();
        sync.state = 'listening';
        if (!port) ensureAudioSync();
        renderPanel();
        break;
      default: break;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) if (k in DEFAULTS) settings[k] = newValue ?? DEFAULTS[k];
    if (!data) return; // этот фрейм не плеер
    // новая задержка по умолчанию сразу применяется, если её ещё не меняли для этой серии/озвучки
    if ('startDelay' in changes && offsetHow === 'default') setOffset(Number(settings.startDelay) || 0, 'default', { save: false });
    if ('noSpoilers' in changes && settings.noSpoilers && !knownIds) loadKnown();
    if ('autoSync' in changes) {
      if (settings.autoSync) ensureAudioSync();
      else if (!oneShot) stopListening();
    }
    renderPanel();
    applyPosition();
    if (!settings.enabled) clearBanners();
  });

  const first = pickVideo();
  if (first) attachVideo(first);
})();
