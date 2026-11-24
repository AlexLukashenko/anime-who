// Сквозной тест расширения на поддельных сайтах (см. README.md рядом).
// Истинная задержка синтетической серии — 17.3 с. Упоминания (время видео):
// Маомао 118.2, 173.1, 215.0, 239.5, 306.5 · Адо 125.8, 235.3 · Жэньши 157.6, 249.9
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = new URL('./.out', import.meta.url).pathname;
const EXT = new URL('../../extension', import.meta.url).pathname;
const TRUE_OFFSET = 17.3;
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
const setSettings = (obj) => sw.evaluate((o) => chrome.storage.sync.set(o), obj);
const syncState = () => sw.evaluate(async () => Object.values(await chrome.storage.session.get(null))[0]?.sync || null);
async function waitFor(fn, sec, step = 500) {
  const until = Date.now() + sec * 1000;
  while (Date.now() < until) {
    const r = await fn();
    if (r) return r;
    await sleep(step);
  }
  return null;
}

let frame;
const banners = () => frame.evaluate(() => {
  const h = document.querySelector('kto-eto-overlay');
  return h ? [...h.shadowRoot.querySelectorAll('.banner')].map((b) => ({
    name: b.querySelector('.name')?.textContent,
    sub: b.querySelector('.sub')?.textContent || '',
    token: b.querySelector('.token')?.textContent || '',
    desc: b.querySelector('.desc')?.textContent || '',
    photo: !!b.querySelector('img, .ph'),
    tag: !!b.querySelector('.tag'),
  })) : [];
});
const names = async () => (await banners()).map((b) => b.name);
const videoTime = () => frame.evaluate(() => document.querySelector('video').currentTime);
const jump = (t) => frame.evaluate((x) => {
  const h = document.querySelector('kto-eto-overlay');
  if (h) h.shadowRoot.querySelector('.stack').innerHTML = '';
  document.querySelector('video').currentTime = x;
}, t);
const waitBanner = (name, sec) => waitFor(async () => { const b = await banners(); return b.find((x) => x.name === name) || null; }, sec);

async function openEpisode(page, start) {
  await sleep(1500);
  frame = page.frames().find((f) => f.url().includes('kodikplayer'));
  await frame.evaluate((s) => { const v = document.querySelector('video'); v.currentTime = s; return v.play(); }, start);
}

// 1. Автоподбор включён по умолчанию, но баннеры не ждут: идут с задержкой из настроек (17 с)
await setSettings({ startDelay: 17 });
const page = await ctx.newPage();
await page.goto('https://old.yummyani.me/catalog/item/monolog-farmacevta-3');
await openEpisode(page, 112);
const b1 = await waitBanner('Маомао', 12);
let st = await syncState();
check('баннер сразу, пока идёт автоподбор', !!b1 && st?.state === 'listening', JSON.stringify(st));
check('задержка пока из настроек', st?.how === 'default' && st?.offset === 17);
await page.screenshot({ path: `${OUT}/banner.png` });

// 2. Автоподбор уточняет задержку
const t0 = Date.now();
st = await waitFor(async () => { const s = await syncState(); return s?.how === 'auto' ? s : null; }, 100, 2000);
check('автоподбор уточнил задержку', st && Math.abs(st.offset - TRUE_OFFSET) <= 0.4, `${JSON.stringify(st)} за ${((Date.now() - t0) / 1000).toFixed(0)} с`);

// 3. Тумблер автоподбора выключает прослушивание, задержка остаётся
await setSettings({ autoSync: false });
st = await waitFor(async () => { const s = await syncState(); return s?.state === 'idle' ? s : null; }, 5);
check('тумблер выключает автоподбор', st?.state === 'idle' && st?.how === 'auto', JSON.stringify(st));

// 4. Чек-лист полей: без фото, + латиница, + слово из реплики, + описание без спойлера
await setSettings({ fPhoto: false, fRomaji: true, fToken: true, fDesc: true, cooldownSeconds: 0 });
await sleep(300);
await jump(170);
const b4 = await waitBanner('Маомао', 8);
check('поля баннера по чек-листу', b4 && !b4.photo && b4.sub.includes('Maomao') && b4.sub.includes('猫猫') && b4.token.includes('猫猫'), JSON.stringify(b4));
check('описание без BBCode и спойлера', b4 && b4.desc.startsWith('Девушка-фармацевт') && b4.desc.includes('Жэньши') && !b4.desc.includes('СЕКРЕТ') && !b4.desc.includes('['), JSON.stringify(b4?.desc));
await page.screenshot({ path: `${OUT}/banner-fields.png` });

// 5. «Не показывать главных героев»: Маомао (215) пропускается, Адо (235.3) показывается
await setSettings({ showMain: false });
await sleep(300);
await jump(212);
await waitFor(async () => (await videoTime()) > 218, 10);
check('главные герои скрыты', !(await names()).includes('Маомао'), JSON.stringify(await names()));
await jump(233);
const b5 = await waitBanner('Адо', 6);
check('второстепенные показываются', !!b5);
await setSettings({ showMain: true, fPhoto: true, fRomaji: false, fToken: false, fDesc: false });

// 6. Перемотка вперёд: пропущенное не вываливается пачкой, следующее — вовремя (Маомао 306.5)
await sleep(300);
await jump(300);
await sleep(1500);
check('скачок вперёд без пачки баннеров', (await names()).length === 0, JSON.stringify(await names()));
const b6 = await waitBanner('Маомао', 10);
const t6 = await videoTime();
check('после скачка — вовремя', !!b6 && t6 >= 306 && t6 <= 309, `на ${t6.toFixed(1)} с`);

// 7. Перемотка назад: Жэньши (249.9)
await jump(247);
const b7 = await waitBanner('Жэньши', 6);
const t7 = await videoTime();
check('после перемотки назад — по новому месту', !!b7 && t7 >= 249.5 && t7 <= 252, `на ${t7.toFixed(1)} с`);

// 7б. Ссылка на Shikimori из панели персонажей — новая вкладка
await frame.evaluate(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.toggle').click());
await sleep(800);
await page.screenshot({ path: `${OUT}/panel.png` });
const linkInfo = await frame.evaluate(() => {
  const a = document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.list a.ext[data-open]');
  return { href: a.href, text: a.textContent };
});
const [shikiPage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null),
  frame.evaluate(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.list a.ext[data-open]').click()),
]);
if (shikiPage) await shikiPage.waitForLoadState('domcontentloaded').catch(() => {});
check('ссылка из панели открывает Shikimori в новой вкладке', shikiPage?.url() === linkInfo.href && /^https:\/\/shikimori\.io\/characters\/\d+$/.test(linkInfo.href),
  `${linkInfo.text} → ${shikiPage?.url()}`);
check('плеер остался на месте', ctx.pages().includes(page) && !page.isClosed());
await shikiPage?.close();
await frame.evaluate(() => document.querySelector('kto-eto-overlay').shadowRoot.querySelector('.close').click());

// 8. Окно расширения: обе вкладки
const tabId = Number(Object.keys(await sw.evaluate(() => chrome.storage.session.get(null)))[0].split(':')[1]);
const extId = sw.url().split('/')[2];
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 384, height: 600 });
await pop.goto(`chrome-extension://${extId}/ui/popup.html?tab=${tabId}`);
await sleep(1200);
check('тумблер автоподбора в окне отражает настройку', (await pop.isChecked('[data-setting="autoSync"]')) === false);
await pop.screenshot({ path: `${OUT}/popup-episode.png`, fullPage: true });
await pop.click('[data-tab="settings"]');
await pop.click('[data-setting="fDesc"]');
await sleep(400);
check('флажок в окне сохраняется в настройки', (await sw.evaluate(async () => (await chrome.storage.sync.get('fDesc')).fDesc)) === true);
await pop.screenshot({ path: `${OUT}/popup-settings.png`, fullPage: true });
await pop.close();

// 9. Перезагрузка — сохранённая (подобранная) задержка
await page.reload();
await openEpisode(page, 112);
const b9 = await waitBanner('Маомао', 12);
st = await syncState();
check('после перезагрузки — сохранённая задержка и баннер', !!b9 && st?.how === 'saved' && Math.abs(st.offset - TRUE_OFFSET) <= 0.4, JSON.stringify(st));

if (errors.length) console.log(errors.join('\n'));
console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
await ctx.close();
process.exit(failed ? 1 : 0);
