// Сквозной тест: другие плееры YummyAnime и сайт в стиле DreamCast (см. README.md рядом).
// Упоминания (время видео при задержке 17.3 с): Маомао 118.2 · Адо 125.8
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = new URL('./.out', import.meta.url).pathname;
const EXT = new URL('../../extension', import.meta.url).pathname;
const hosts = ['old.yummyani.me', 'ru.yummyani.me', 'kodikplayer.com', 'cdn-player.test', 'dreamerscast.com', 'shikimori.io', 'graphql.anilist.co', 'jimaku.cc'];

const ctx = await chromium.launchPersistentContext(`/tmp/pw-profile-${Date.now()}`, {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1100, height: 760 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1`).join(',')}`,
    '--ignore-certificate-errors',
    '--no-proxy-server',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const errors = [];
sw.on('console', (m) => { if (m.type() === 'error') errors.push(`[sw] ${m.text()}`); });

let failed = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, sec, step = 500) {
  const until = Date.now() + sec * 1000;
  while (Date.now() < until) {
    const r = await fn();
    if (r) return r;
    await sleep(step);
  }
  return null;
}
const tabState = (part) => sw.evaluate(async (u) => {
  const all = await chrome.storage.session.get(null);
  const hit = Object.entries(all).find(([, v]) => (v.url || '').includes(u));
  return hit ? { id: Number(hit[0].split(':')[1]), ...hit[1] } : null;
}, part);
const overlayOf = (frame) => frame.evaluate(() => {
  const h = document.querySelector('kto-eto-overlay');
  return {
    banners: h ? [...h.shadowRoot.querySelectorAll('.banner .name')].map((x) => x.textContent) : [],
    toasts: h ? [...h.shadowRoot.querySelectorAll('.toast')].map((x) => x.textContent) : [],
  };
});
const play = (frame, t) => frame.evaluate((s) => { const v = document.querySelector('video'); v.currentTime = s; return v.play(); }, t);
const waitBanner = (frame, name, sec) => waitFor(async () => ((await overlayOf(frame)).banners.includes(name) ? true : null), sec);

await sw.evaluate(() => chrome.storage.sync.set({ startDelay: 17.3, autoSync: false }));

// 1. YummyAnime, плеер CVH: обёртка ru.yummyani.me → вложенный плеер с другого домена, без номера серии в адресе
const page = await ctx.newPage();
await page.goto('https://old.yummyani.me/catalog/item/monolog-farmacevta-3');
await sleep(1000);
await page.evaluate(() => { document.getElementById('player').src = 'https://ru.yummyani.me/iframeCVH.html?dubbing_code=AnimeVost&anime_id=61967&episode=1&dubbing=%D0%9E%D0%B7%D0%B2%D1%83%D1%87%D0%BA%D0%B0+AnimeVost'; });
const cvh = await waitFor(async () => page.frames().find((f) => f.url().includes('cdn-player.test')) || null, 10);
await sleep(800);
await play(cvh, 112);
const b1 = await waitBanner(cvh, 'Маомао', 14);
let st = await tabState('old.yummyani.me');
check('CVH: баннер во вложенном плеере', !!b1);
check('CVH: серия и озвучка из API YummyAnime', st?.episode === 1 && st?.episodeSource === 'site' && st?.dubKey === 'animevost' && st?.player === 'Плеер CVH',
  JSON.stringify({ ep: st?.episode, src: st?.episodeSource, dub: st?.dubKey, player: st?.player }));
await page.screenshot({ path: `${OUT}/cvh.png` });
await page.close();

// 2. Сайт в стиле DreamCast: видео на самой странице, аниме ищется по названию
const dc = await ctx.newPage();
await dc.goto('https://dreamerscast.com/release/kusuriya-3/1');
await sleep(1200);
await play(dc.mainFrame(), 112);
const b2 = await waitBanner(dc.mainFrame(), 'Маомао', 14);
st = await tabState('kusuriya-3');
check('DreamCast: баннер на странице с видео', !!b2);
check('DreamCast: аниме найдено по названию, серия со страницы, озвучка Dream Cast',
  st?.malId === 61987 && st?.malSource === 'search' && st?.episode === 1 && st?.episodeSource === 'page' && st?.dubKey === 'dreamcast',
  JSON.stringify({ mal: st?.malId, malSrc: st?.malSource, ep: st?.episode, epSrc: st?.episodeSource, dub: st?.dubKey }));
await dc.screenshot({ path: `${OUT}/dreamcast.png` });
await dc.close();

// 3. Неизвестное аниме: подсказка, затем ручной выбор в окне расширения
const unk = await ctx.newPage();
await unk.goto('https://dreamerscast.com/release/unknown/1');
await sleep(1200);
await play(unk.mainFrame(), 112);
const t3 = await waitFor(async () => (await overlayOf(unk.mainFrame())).toasts.find((x) => x.includes('Не понял')) || null, 12);
check('неизвестное аниме: подсказка указать вручную', !!t3, t3 || '');
st = await tabState('unknown');
const extId = sw.url().split('/')[2];
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 384, height: 640 });
await pop.goto(`chrome-extension://${extId}/ui/popup.html?tab=${st.id}`);
await sleep(1000);
const whatTitle = await pop.textContent('#what-title');
check('окно: «Что смотрим» показывает, что аниме не определилось', !(await pop.isHidden('#what-edit')), whatTitle);
await pop.screenshot({ path: `${OUT}/popup-what-unknown.png`, fullPage: true });
await pop.fill('#anime-input', 'https://shikimori.io/animes/z61987-kusuriya-no-hitorigoto-3rd-season');
await pop.click('#save-what');
await sleep(2500);
await play(unk.mainFrame(), 112);
const b3 = await waitBanner(unk.mainFrame(), 'Маомао', 14);
st = await tabState('unknown');
check('после ручного выбора аниме — баннеры', !!b3 && st?.malId === 61987 && st?.malSource === 'manual', JSON.stringify({ mal: st?.malId, src: st?.malSource }));

// 4. Ручной выбор серии
await pop.fill('#ep-input', '2');
await pop.click('#save-what');
await sleep(1500);
await play(unk.mainFrame(), 60);
st = await waitFor(async () => { const s = await tabState('unknown'); return s?.episode === 2 ? s : null; }, 12);
check('ручной выбор серии', st?.episode === 2 && st?.episodeSource === 'manual', JSON.stringify({ ep: st?.episode, src: st?.episodeSource, status: st?.lastStatus }));
await pop.reload();
await sleep(1200);
await pop.screenshot({ path: `${OUT}/popup-what.png`, fullPage: true });
const persisted = await sw.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('ovr:')));
check('ручной выбор запомнен для страницы', persisted.some(([k, v]) => k.includes('dreamerscast.com/release/unknown/1') && v.malId === 61987 && v.episode === 2), JSON.stringify(persisted));

if (errors.length) console.log(errors.join('\n'));
console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
await ctx.close();
process.exit(failed ? 1 : 0);
