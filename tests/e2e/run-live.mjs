// Сквозной тест на настоящем YummyAnime: настоящие Shikimori, AniList, Jimaku и плеер.
// Нужен Playwright (npm i -D playwright && npx playwright install chromium) и интернет.
//
//   node tests/e2e/run-live.mjs                 — проверки
//   node tests/e2e/run-live.mjs --shots         — ещё и скриншоты для README в docs/
//   PAGE=https://old.yummyani.me/catalog/item/… node tests/e2e/run-live.mjs
//   CHROME=/путь/к/chromium node tests/e2e/run-live.mjs   — свой Chromium / Chrome for Testing
//
// Сайты меняются, поэтому тест не для CI, а для проверки перед релизом.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pw = await import('playwright').catch(() => import('playwright-core'));
const { chromium } = pw.default || pw;

const EXT = new URL('../../extension', import.meta.url).pathname;
const DOCS = new URL('../../docs', import.meta.url).pathname;
const PAGE = process.env.PAGE || 'https://old.yummyani.me/catalog/item/monolog-farmacevta-3';
const SEEK = Number(process.env.SEEK || 286); // за пару секунд до упоминания Жэньши в 1 серии
const SHOTS = process.argv.includes('--shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
  if (!ok) failed++;
}
async function waitFor(fn, sec, step = 500) {
  const until = Date.now() + sec * 1000;
  while (Date.now() < until) {
    const r = await fn().catch(() => null);
    if (r) return r;
    await sleep(step);
  }
  return null;
}

const profile = mkdtempSync(join(tmpdir(), 'kto-eto-live-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, // в headless плееры часто не запускают видео
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: SHOTS ? 2 : 1,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
});

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  const tabState = async () => Object.entries(await sw.evaluate(() => chrome.storage.session.get(null))).find(([k]) => k.startsWith('tab:'));
  // Для теста: показывать повторы сразу; в конце вернём настройки по умолчанию
  await sw.evaluate(() => chrome.storage.sync.set({ cooldownSeconds: 0 }));

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Плеер: фрейм, где есть длинное видео
  const findPlayer = async () => {
    // Самый большой фрейм с видео — плеер (рядом бывают рекламные ролики в маленьких фреймах)
    let best = null;
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const has = await f.evaluate(() => !!document.querySelector('video')).catch(() => false);
      const b = has ? await (await f.frameElement()).boundingBox().catch(() => null) : null;
      if (b && b.width >= 480 && (!best || b.width * b.height > best.area)) best = { f, area: b.width * b.height };
    }
    return best?.f || null;
  };
  let frame = await waitFor(findPlayer, 30);
  check('плеер найден', !!frame, frame?.url().slice(0, 60));
  if (!frame) throw new Error('нет плеера');
  const iframe = await frame.frameElement();
  await iframe.scrollIntoViewIfNeeded();
  const box = await iframe.boundingBox();
  const playing = () => frame.evaluate(() => {
    const v = [...document.querySelectorAll('video')].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
    return v && v.duration > 120 && !v.paused;
  });
  // Запуск — жестом пользователя; плеер может быть ещё не готов, поэтому повторяем
  let started = false;
  for (let i = 0; i < 6 && !started; i++) {
    await sleep(3000);
    if (await playing().catch(() => false)) { started = true; break; }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    started = !!(await waitFor(playing, 6));
  }
  check('видео запустилось', started);

  const st = await waitFor(async () => { const t = await tabState(); return t?.[1]?.malId && t[1].subtitle ? t : null; }, 60);
  const info = st?.[1] || {};
  check('аниме и субтитры определились', !!info.malId && !!info.subtitle, `MAL ${info.malId}, ${info.subtitle?.label || '—'}`);
  check('короткая подпись субтитров', !!info.subtitle?.label && info.subtitle.label.length < 40 && info.subtitle.label !== info.subtitle.name, info.subtitle?.label);
  check('пример баннера — персонаж этой серии', !!info.sample?.ru && !!info.sample?.img, info.sample?.ru);

  const prequels = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('shiki3:')));
  check('загружены прошлые сезоны', prequels.length >= 2, prequels.join(', '));

  // Баннер
  const overlay = (fn, arg) => frame.evaluate(fn, arg);
  await page.mouse.move(5, 5);
  await overlay((t) => { const v = [...document.querySelectorAll('video')].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0]; v.currentTime = t; v.play(); }, SEEK);
  const banner = await waitFor(() => overlay(() => {
    const b = document.querySelector('kto-eto-overlay')?.shadowRoot.querySelector('.banner');
    return b ? { name: b.querySelector('.name')?.textContent, tag: b.querySelector('.tag')?.textContent } : null;
  }), 40);
  check('баннер появился', !!banner, JSON.stringify(banner));
  check('пометка с учётом рода', !!banner && /^упомянут[аa]?$/.test(banner.tag), banner?.tag);
  if (SHOTS && banner) { await sleep(1200); await page.screenshot({ path: `${DOCS}/banner.jpg`, type: 'jpeg', quality: 82, clip: box }); }

  // Панель
  await overlay(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.toggle').click());
  await sleep(1500);
  const status = await overlay(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.status').innerHTML);
  check('в панели короткая подпись, полное имя — в подсказке', /Jimaku · [^<]+<\/span>/.test(status) && /title="[^"]+\.(srt|ass|vtt|ssa)"/.test(status));
  if (SHOTS) { await page.mouse.move(5, 5); await sleep(3000); await page.screenshot({ path: `${DOCS}/panel.jpg`, type: 'jpeg', quality: 82, clip: box }); }

  // Режим без спойлеров
  await sw.evaluate(() => chrome.storage.sync.set({ noSpoilers: true }));
  const note = await waitFor(() => overlay(() => {
    const r = document.querySelector('kto-eto-overlay').shadowRoot;
    const n = r.querySelector('.hidden-note')?.textContent || '';
    return n.includes('проверяю') ? null : { note: n, items: r.querySelectorAll('.item').length };
  }), 90, 1000);
  check('без спойлеров: проверка прошлых серий завершилась', !!note, JSON.stringify(note));
  await sw.evaluate(() => chrome.storage.sync.set({ noSpoilers: false }));
  await overlay(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.close').click());

  // Карточка по клику на персонажа: пауза, описание, связи; закрытие — снова играет
  await overlay(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.stack').replaceChildren());
  await overlay((t) => { const v = [...document.querySelectorAll('video')].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0]; v.currentTime = t; v.play(); }, SEEK);
  await sleep(500);
  const clicked = await waitFor(() => overlay(() => {
    const r = document.querySelector('kto-eto-overlay').shadowRoot;
    const b = r.querySelector('.banner[data-id]');
    if (b) { b.click(); return 'banner'; }
    return null;
  }), 60);
  const cardInfo = await waitFor(() => overlay(() => {
    const r = document.querySelector('kto-eto-overlay').shadowRoot;
    const c = r.querySelector('.card');
    if (!c?.dataset.loaded) return null;
    const v = [...document.querySelectorAll('video')].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
    return { name: c.querySelector('.name').textContent, loaded: c.dataset.loaded, desc: c.querySelector('.desc').textContent.length,
      rel: c.querySelectorAll('.rel .chip').length, seyu: !c.querySelector('.seyu').hidden, paused: v.paused };
  }), 20);
  check('карточка открылась по клику на баннер', !!clicked && !!cardInfo, JSON.stringify(cardInfo));
  check('видео на паузе, пока открыта карточка', !!cardInfo?.paused);
  // Описания на Shikimori есть не у всех — тогда в карточке «нет описания», но сэйю обычно есть
  check('карточка загрузилась с Shikimori', cardInfo?.loaded === 'ok' && (cardInfo.desc > 40 || cardInfo.seyu));
  if (SHOTS && cardInfo) { await page.mouse.move(5, 5); await sleep(3000); await page.screenshot({ path: `${DOCS}/card.jpg`, type: 'jpeg', quality: 82, clip: box }); }
  await overlay(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.card .close').click());
  const resumed = await waitFor(() => overlay(() => !document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.card')
    && ![...document.querySelectorAll('video')].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0].paused), 5);
  check('после закрытия видео снова играет', !!resumed);

  // Окно расширения
  await sw.evaluate(() => chrome.storage.sync.remove('cooldownSeconds'));
  const tabId = Number(st[0].split(':')[1]);
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 384, height: 600 });
  await pop.goto(`chrome-extension://${extId}/ui/popup.html?tab=${tabId}`);
  await sleep(2500);
  if (SHOTS) await pop.screenshot({ path: `${DOCS}/popup-episode.png`, fullPage: true });
  await pop.click('[data-tab="settings"]');
  const pv = await waitFor(() => pop.evaluate(() => (document.querySelector('#preview img.pv-ph') ? document.querySelector('#preview .pv-name').textContent : null)), 10);
  check('пример баннера с фото персонажа серии', !!pv, pv);
  if (SHOTS) await pop.screenshot({ path: `${DOCS}/popup-settings.png`, fullPage: true });
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failed ? `\nПровалено: ${failed}` : '\nВсё прошло');
process.exit(failed ? 1 : 0);
