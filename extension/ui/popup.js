import { SETTINGS_DEFAULTS } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
// ?tab=ID — для отладки: открыть окно расширения как страницу для конкретной вкладки
const forcedTab = Number(new URLSearchParams(location.search).get('tab'));
const tab = forcedTab ? { id: forcedTab } : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

function fmt(x) {
  if (x == null) return '—';
  return `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)} с`;
}

const HOW = {
  default: 'по умолчанию из настроек',
  site: 'заставка сайта в начале серии',
  auto: 'подобрана по звуку ✓',
  manual: 'выставлена вручную, запомнена для этой озвучки',
  saved: 'сохранена для этой серии',
  'anime-dub': 'как в прошлой серии с этой озвучкой',
  dub: 'как у этой озвучки в других аниме',
};

// ---------- вкладки ----------

for (const b of document.querySelectorAll('.tab')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.tab')) x.classList.toggle('active', x === b);
    $('pane-episode').hidden = b.dataset.tab !== 'episode';
    $('pane-settings').hidden = b.dataset.tab !== 'settings';
  });
}

// ---------- настройки: двусторонняя привязка [data-setting] ↔ chrome.storage.sync ----------

let settings = { ...SETTINGS_DEFAULTS };

function applySettingsToForm() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const key = el.dataset.setting;
    if (document.activeElement === el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
  }
  renderPreview();
}

for (const el of document.querySelectorAll('[data-setting]')) {
  el.addEventListener('change', () => {
    const key = el.dataset.setting;
    const def = SETTINGS_DEFAULTS[key];
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (typeof def === 'number') {
      v = Number(String(el.value).replace(',', '.'));
      if (!Number.isFinite(v)) v = def;
    } else v = el.value;
    settings[key] = v;
    chrome.storage.sync.set({ [key]: v });
    renderPreview();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? SETTINGS_DEFAULTS[k];
  applySettingsToForm();
});

// ---------- пример баннера ----------

// Пока серия не определилась — Маомао с заглушкой вместо фото; потом — настоящий персонаж этой серии.
const FALLBACK_SAMPLE = {
  ru: 'Маомао', jp: '猫猫', romaji: 'Maomao', role: 'main', token: '猫猫', gender: 'f',
  desc: 'Девушка-фармацевт, похищенная и проданная во дворец. Разбирается в ядах и лекарствах лучше придворных лекарей.',
};
let sample = FALLBACK_SAMPLE;
let samplePhoto = null; // { img, dataUrl }

function tagFor(c) {
  return c.gender === 'f' ? 'упомянута' : c.gender === 'm' ? 'упомянут' : 'упомянут(а)';
}

function setSample(next) {
  const s = next?.ru ? next : FALLBACK_SAMPLE;
  if (s.img && samplePhoto?.img !== s.img) {
    samplePhoto = { img: s.img, dataUrl: null };
    chrome.runtime.sendMessage({ type: 'image', url: s.img }).then((r) => {
      if (samplePhoto?.img !== s.img) return;
      samplePhoto.dataUrl = r?.dataUrl || null;
      renderPreview();
    }).catch(() => {});
  }
  if (s === sample || (s.id && s.id === sample.id)) return;
  sample = s;
  renderPreview();
}

function renderPreview() {
  const s = settings;
  const c = sample;
  const names = [];
  if (s.fRu && c.ru) names.push(c.ru);
  if (s.fJp && c.jp) names.push(c.jp);
  if (s.fRomaji && c.romaji && c.romaji !== c.ru) names.push(c.romaji);
  if (!names.length) names.push(c.ru || c.romaji || c.jp);
  const [primary, ...rest] = names;
  const sub = [...rest, s.fRole ? (c.role === 'main' ? 'главный персонаж' : 'второстепенный') : null].filter(Boolean).join(' · ');
  const photo = c.img && samplePhoto?.img === c.img ? samplePhoto.dataUrl : null;
  const box = $('preview');
  box.innerHTML = `<div class="pv">${s.fPhoto ? (photo ? '<img class="pv-ph" alt="">' : '<div class="pv-ph"></div>') : ''}<div>
    ${s.fTag ? '<div class="pv-tag"></div>' : ''}<div class="pv-name"></div>
    ${sub ? '<div class="pv-sub"></div>' : ''}${s.fToken && c.token ? '<div class="pv-token"></div>' : ''}${s.fDesc && c.desc ? '<div class="pv-desc"></div>' : ''}</div></div>`;
  if (photo) box.querySelector('img.pv-ph').src = photo;
  if (s.fTag) box.querySelector('.pv-tag').textContent = tagFor(c);
  box.querySelector('.pv-name').textContent = primary;
  if (sub) box.querySelector('.pv-sub').textContent = sub;
  if (s.fToken && c.token) box.querySelector('.pv-token').textContent = `в реплике: «${c.token}»`;
  if (s.fDesc && c.desc) box.querySelector('.pv-desc').textContent = c.desc;
}

// ---------- вкладка «Серия» ----------

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: 'popup-state', tabId: tab.id }).catch(() => null);
  settings = { ...SETTINGS_DEFAULTS, ...(st?.settings || {}) };
  applySettingsToForm();
  const info = st?.info || {};
  setSample(info.sample);
  if (!info.site && !info.malId) {
    $('unsupported').hidden = false;
    $('main').hidden = true;
    $('what').hidden = true;
    return;
  }
  $('unsupported').hidden = true;
  $('what').hidden = false;
  renderWhat(info);
  $('main').hidden = !info.malId;
  $('title').textContent = `${info.title || info.pageTitle || ''}${info.episode ? ` — ${info.episode} серия` : ''}`;

  const sel = $('subs');
  if (document.activeElement !== sel) {
    const cands = info.candidates || [];
    const current = info.subtitle;
    sel.innerHTML = '';
    if (current?.custom) sel.add(new Option(`Свой файл: ${current.name}`, '__custom', true, true));
    for (const c of cands) sel.add(new Option(c.name, c.url, false, current?.url === c.url));
    if (!sel.options.length) sel.add(new Option(info.lastStatus === 'no-subs' ? 'Не найдено — загрузите свой файл' : 'Загрузка…', ''));
  }

  const s = info.sync || {};
  if (document.activeElement !== $('delay')) $('delay').value = s.offset != null ? s.offset : '';
  let text = s.offset != null ? `Субтитры на ${fmt(s.offset)} позже начала видео — ${HOW[s.how] || ''}.` : 'Задержка ещё не задана.';
  if (s.state === 'need-tab-capture') text += ' Плеер не отдаёт звук — нажмите «Слушать звук вкладки».';
  else if (s.state === 'listening') text += ` Слушаю звук${s.observed ? ` (${s.observed} с)` : ''}…`;
  if (s.manual && settings.autoSync) text += ' Ручная правка: автоподбор её не меняет до «Подобрать заново».';
  if (s.vad === 'energy') text += ' (упрощённый детектор речи)';
  $('sync').textContent = text;
  $('tabcap').hidden = s.state !== 'need-tab-capture';
  $('tabcap').classList.toggle('accent', s.state === 'need-tab-capture');
}

// ---------- «Что смотрим»: определилось само или выбрано вручную ----------

const MAL_SOURCE = { page: 'по ссылке на странице', search: 'найдено по названию страницы', manual: 'выбрано вручную' };
const EP_SOURCE = {
  manual: 'выбрана вручную', site: 'с сайта', player: 'из адреса плеера', page: 'со страницы',
  kodik: 'из плеера Kodik', default: 'не определилась — считаю первой',
};
let whatTouched = false;

function renderWhat(info) {
  if (info.malId) {
    $('what-title').textContent = info.title || info.pageTitle || `Shikimori ID ${info.malId}`;
    $('what-ep').textContent = [
      MAL_SOURCE[info.malSource] || '',
      info.episode ? `серия ${info.episode} — ${EP_SOURCE[info.episodeSource] || ''}` : 'серия определится, когда запустите видео',
    ].filter(Boolean).join(' · ');
  } else {
    $('what-title').textContent = info.pageTitle || 'Аниме не определилось';
    $('what-ep').textContent = 'Не нашёл это аниме на Shikimori — укажите ссылку ниже.';
    $('what-edit').hidden = false;
  }
  if (!whatTouched) {
    $('anime-input').value = info.override?.malId ? `https://shikimori.io/animes/${info.override.malId}` : '';
    $('ep-input').value = info.override?.episode || '';
  }
}

$('what-toggle').addEventListener('click', () => { $('what-edit').hidden = !$('what-edit').hidden; });
for (const id of ['anime-input', 'ep-input']) $(id).addEventListener('input', () => { whatTouched = true; });

async function saveWhat(anime, episode) {
  const r = await chrome.runtime.sendMessage({ type: 'popup-override', tabId: tab.id, anime, episode });
  $('what-msg').textContent = r?.ok ? 'Сохранено — плеер перезагрузит данные.' : (r?.error || 'Не получилось');
  whatTouched = false;
  setTimeout(refresh, 1500);
}
$('save-what').addEventListener('click', () => saveWhat($('anime-input').value, $('ep-input').value));
$('reset-what').addEventListener('click', () => { $('anime-input').value = ''; $('ep-input').value = ''; saveWhat('', ''); });

function forward(payload) {
  return chrome.runtime.sendMessage({ type: 'popup-forward', tabId: tab.id, payload: { ...payload, target: 'player' } });
}

$('subs').addEventListener('change', async (e) => {
  const url = e.target.value;
  if (!url || url === '__custom') return;
  await chrome.runtime.sendMessage({ type: 'popup-choose-subtitle', tabId: tab.id, url });
  setTimeout(refresh, 1500);
});

$('file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  await chrome.runtime.sendMessage({ type: 'popup-upload-subtitle', tabId: tab.id, name: f.name, text });
  setTimeout(refresh, 1500);
});

for (const b of document.querySelectorAll('[data-d]')) {
  b.addEventListener('click', async () => {
    await forward({ type: 'offset-adjust', delta: Number(b.dataset.d) });
    setTimeout(refresh, 300);
  });
}

$('delay').addEventListener('change', async (e) => {
  const v = Number(String(e.target.value).replace(',', '.'));
  if (!Number.isFinite(v)) return;
  await forward({ type: 'offset-set', value: v });
  setTimeout(refresh, 300);
});

$('resync').addEventListener('click', async () => {
  await forward({ type: 'resync' });
  setTimeout(refresh, 500);
});

$('tabcap').addEventListener('click', async () => {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await chrome.runtime.sendMessage({ type: 'popup-tab-capture', tabId: tab.id, streamId });
    $('sync').textContent = 'Слушаю звук вкладки…';
  } catch (e) {
    $('sync').textContent = `Не удалось захватить звук вкладки: ${e.message || e}`;
  }
});

$('panel').addEventListener('click', async () => {
  await forward({ type: 'toggle-panel' });
  window.close();
});

refresh();
setInterval(refresh, 2000);
