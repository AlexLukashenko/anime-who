// Поддельные yummyani / kodik / shikimori / anilist / jimaku для сквозного теста.
import https from 'node:https';
import fs from 'node:fs';
const OUT = new URL('./.out', import.meta.url).pathname;
import zlib from 'node:zlib';

const log = [];
const png = (r, g, b) => {
  // однотонный PNG 60x80
  const w = 60, h = 80;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return crc ^ 0xffffffff; }

const chars = [
  { id: '155904', name: 'Maomao', russian: 'Маомао', japanese: '猫猫', synonyms: ['Xiaomao'], role: 'Main', color: [220, 120, 160], description: 'Девушка-фармацевт при дворе, помогает [character=156096 жэньши]. [spoiler=спойлер]СЕКРЕТНЫЙ СПОЙЛЕР[/spoiler] Разбирается в ядах.' },
  { id: '156096', name: 'Renshi', russian: 'Жэньши', japanese: '壬氏', synonyms: ['Jinshi '], role: 'Main', color: [120, 140, 230] },
  { id: '178876', name: 'Gaoshun', russian: 'Гаошунь', japanese: '高順', synonyms: ['Gaoshun '], role: 'Supporting', color: [120, 200, 140] },
  { id: '178877', name: 'Ah-Duo', russian: 'Адо', japanese: '阿多', synonyms: ['Ah-Duo '], role: 'Supporting', color: [230, 190, 90] },
];

const shikiResponse = {
  data: { animes: [{
    id: '61987', malId: '61987', name: 'Kusuriya no Hitorigoto 3rd Season', russian: 'Монолог фармацевта 3', japanese: '薬屋のひとりごと 第3期',
    english: 'The Apothecary Diaries Season 3', synonyms: [], episodes: 12, episodesAired: 8, kind: 'tv',
    characterRoles: chars.map((c) => ({ rolesEn: [c.role], character: { id: c.id, name: c.name, russian: c.russian, japanese: c.japanese, synonyms: c.synonyms, description: c.description || null, poster: { previewUrl: `https://shikimori.io/uploads/poster/characters/${c.id}/preview.png`, mainUrl: null } } })),
  }] },
};

const anilistResponse = { data: { Media: { id: 195516, episodes: 12, title: { romaji: 'Kusuriya no Hitorigoto 3rd Season', english: null, native: '薬屋のひとりごと 第3期' },
  characters: { edges: [
    { role: 'MAIN', node: { id: 1, name: { full: 'Maomao', native: '猫猫', alternative: ['Xiaomao', '小猫'] } } },
    { role: 'MAIN', node: { id: 2, name: { full: 'Jinshi', native: '壬氏', alternative: ['Renshi'] } } },
  ] } } } };

const esc = (o) => JSON.stringify(o).replace(/"/g, '&#34;');
const jimakuHome = `<html><body><div class="table">
<div class="entry" data-extra="${esc({ name: 'Kusuriya no Hitorigoto 2nd Season', flags: 1, anilist_id: 161645, english_name: 'S2', japanese_name: '薬屋のひとりごと 第2期' })}">
    <a href="/entry/8485" class="table-data file-name">Kusuriya no Hitorigoto 2nd Season</a></div>
<div class="entry" data-extra="${esc({ name: 'Kusuriya no Hitorigoto 3rd Season', flags: 1, last_modified: 1795232054, anilist_id: 195516, tmdb_id: null, english_name: 'The Apothecary Diaries Season 3', japanese_name: '薬屋のひとりごと 第3期' })}">
    <a href="/entry/12643" class="table-data file-name">Kusuriya no Hitorigoto 3rd Season</a></div>
</div></body></html>`;
const files = [
  '[Nekomoe kissaten&LoliHouse] Kusuriya no Hitorigoto - 49 [WebRip 1080p HEVC-10bit AAC ASSx2][CHS, JPN].ass',
  '薬屋のひとりごと.S03E49.蝗.WEBRip.Netflix.ja[cc].srt',
  '薬屋のひとりごと.S03E50.何か.WEBRip.Netflix.ja[cc].srt',
];
const jimakuEntry = `<html><body><div class="files">${files.map((n) => `<div class="entry" data-extra="${esc({ url: `/entry/12643/download/${encodeURIComponent(n)}`, name: n, size: 22000, last_modified: '2026-10-05T23:41:16Z' })}">
<a href="/entry/12643/download/${encodeURIComponent(n)}">${n}</a></div>`).join('\n')}</div></body></html>`;

const KODIK_URL = '//kodikplayer.com/season/123089/abc/720p?translations=false&only_episode=true&only_season=true&episode=1';
const CVH_URL = '//ru.yummyani.me/iframeCVH.html?dubbing_code=AnimeVost&anime_id=61967&episode=1&dubbing=%D0%9E%D0%B7%D0%B2%D1%83%D1%87%D0%BA%D0%B0+AnimeVost';
const yummyApi = { response: [
  { iframe_url: KODIK_URL, number: '1', data: { dubbing: 'Озвучка AniLibria', player: 'Плеер Kodik' } },
  { iframe_url: KODIK_URL.replace('episode=1', 'episode=2'), number: '2', data: { dubbing: 'Озвучка AniLibria', player: 'Плеер Kodik' } },
  { iframe_url: CVH_URL, number: '1', data: { dubbing: 'Озвучка AnimeVost', player: 'Плеер CVH' } },
] };
// Обёртка CVH: внутри — плеер с другого домена, без номера серии в адресе
const cvhWrapper = `<!doctype html><html><body style="margin:0;background:#000"><iframe src="https://cdn-player.test/embed/xyz" style="border:0;width:100%;height:100vh" allow="autoplay; fullscreen"></iframe></body></html>`;
const genericPlayer = `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%}</style></head>
<body><video src="/episode.webm" preload="auto" playsinline></video></body></html>`;
// Сайт в стиле DreamCast: видео прямо на странице, ссылки на Shikimori нет
const dreamPage = (title, ep) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} — ${ep} серия | Dream Cast</title>
<style>body{background:#16161d;color:#eee;font-family:sans-serif;margin:0}main{padding:10px 20px}video{width:960px;height:540px;background:#000}
.eps span{display:inline-block;padding:4px 10px;margin:2px;background:#333}.eps .active{background:#c33}</style></head>
<body><main><h1>${title}</h1><div class="eps">${[1, 2, 3].map((n) => `<span class="${n === ep ? 'active' : ''}">${n}</span>`).join('')}</div>
<video id="v" src="/episode.webm" preload="auto" playsinline></video></main></body></html>`;

const yummyPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="page_id" content="24452"><title>Монолог фармацевта 3</title></head><body style="background:#222;color:#eee;font-family:sans-serif">
<h1>Монолог фармацевта 3</h1>
<a href="https://shikimori.io/animes/61987">Shikimori</a> <a href="https://myanimelist.net/anime/61987">MAL</a>
<div class="selectors"><div class=" css-12t1xcb-singleValue">Озвучка AniLibria (8 эп.)</div><div class=" css-12t1xcb-singleValue">Плеер Kodik (8 эп.)</div></div>
<div style="width:960px;height:540px"><iframe id="player" src="https:${KODIK_URL}&skip_button=%5Bending%5D1427-1446"
 width="960" height="540" allow="autoplay *; fullscreen *" allowfullscreen frameborder="0"></iframe></div></body></html>`;

const kodikPage = `<!doctype html><html><head><meta charset="utf-8"><title>Kodik Player</title>
<style>html,body{margin:0;background:#000;height:100%;overflow:hidden} .main-box{width:100%;height:100%} video{width:100%;height:100%}</style></head>
<body><div class="main-box"><video id="v" src="/episode.webm" preload="auto" playsinline></video></div>
<script>
  parent.postMessage(JSON.stringify({key:'kodik_player_current_episode',value:{episode:null,season:null,translation:{id:610,title:'AniLibria.TV'}}}),'*');
  const v=document.getElementById('v');
  v.addEventListener('timeupdate',()=>parent.postMessage({key:'kodik_player_time_update',value:Math.floor(v.currentTime)},'*'));
</script></body></html>`;

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
  res.end(body);
}

function sendVideo(req, res) {
  const stat = fs.statSync(OUT + '/episode.webm');
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = Number(s); const end = e ? Number(e) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(OUT + '/episode.webm', { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  return fs.createReadStream(OUT + '/episode.webm').pipe(res);
}

const server = https.createServer({ key: fs.readFileSync(OUT + '/key.pem'), cert: fs.readFileSync(OUT + '/cert.pem') }, (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, `https://${host}`);
  log.push(`${req.method} ${host}${url.pathname}`);
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '');
  if (host === 'old.yummyani.me') {
    if (url.pathname === '/api/anime/24452/videos') return send(res, 200, 'application/json', JSON.stringify(yummyApi));
    return send(res, 200, 'text/html; charset=utf-8', yummyPage);
  }
  if (host === 'ru.yummyani.me') return send(res, 200, 'text/html; charset=utf-8', cvhWrapper);
  if ((host === 'cdn-player.test' || host === 'dreamerscast.com') && url.pathname === '/episode.webm') return sendVideo(req, res);
  if (host === 'cdn-player.test') return send(res, 200, 'text/html; charset=utf-8', genericPlayer);
  if (host === 'dreamerscast.com') {
    const m = url.pathname.match(/^\/release\/([a-z0-9-]+)\/(\d+)/);
    if (m) return send(res, 200, 'text/html; charset=utf-8', dreamPage(m[1] === 'kusuriya-3' ? 'Монолог фармацевта 3' : 'Совсем неизвестное аниме', Number(m[2])));
  }
  if (host === 'kodikplayer.com') {
    if (url.pathname === '/episode.webm') return sendVideo(req, res);
    return send(res, 200, 'text/html; charset=utf-8', kodikPage);
  }
  if (host === 'shikimori.io') {
    if (url.pathname === '/api/graphql') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const q = JSON.parse(body || '{}');
        if (/animes\(search/.test(q.query || '')) {
          const hit = /фармацевт/i.test(q.variables?.q || '');
          const animes = hit ? [{ id: '61987', malId: '61987', name: 'Kusuriya no Hitorigoto 3rd Season', russian: 'Монолог фармацевта 3', japanese: '薬屋のひとりごと 第3期', english: 'The Apothecary Diaries Season 3', kind: 'tv' }] : [];
          return send(res, 200, 'application/json', JSON.stringify({ data: { animes } }));
        }
        return send(res, 200, 'application/json', JSON.stringify(shikiResponse));
      });
      return;
    }
    const m = url.pathname.match(/characters\/(\d+)\//);
    const c = chars.find((x) => x.id === m?.[1]);
    if (c) return send(res, 200, 'image/png', png(...c.color));
  }
  if (host === 'graphql.anilist.co') return send(res, 200, 'application/json', JSON.stringify(anilistResponse));
  if (host === 'jimaku.cc') {
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', jimakuHome);
    if (url.pathname === '/entry/12643') return send(res, 200, 'text/html; charset=utf-8', jimakuEntry);
    if (url.pathname.startsWith('/entry/12643/download/')) {
      const name = decodeURIComponent(url.pathname.split('/download/')[1]);
      if (name.includes('S03E49')) return send(res, 200, 'text/plain; charset=utf-8', fs.readFileSync(OUT + '/ep01.srt'));
      return send(res, 200, 'text/plain; charset=utf-8', '1\n00:00:01,000 --> 00:00:02,000\n别的\n');
    }
  }
  send(res, 404, 'text/plain', 'not found');
});
server.listen(443, () => console.log('mock on 443'));
process.on('SIGUSR2', () => fs.writeFileSync(OUT + '/requests.log', log.join('\n')));
setInterval(() => fs.writeFileSync(OUT + '/requests.log', log.join('\n')), 2000);
