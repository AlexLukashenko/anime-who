import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitle, cleanText, speechIntervals } from '../extension/lib/subs.js';
import { buildMatcher, matchText, findMentions, romajiKey } from '../extension/lib/names.js';
import { episodeNumberFromName, pickCandidates } from '../extension/lib/episodes.js';
import { SyncEstimator, OffsetTracker } from '../extension/lib/sync.js';

// Синтетические строки в формате японских [cc]-субтитров: метки говорящих, фуригана, ремарки, музыка
const CC_SRT = `1\r\n00:00:04,504 --> 00:00:08,883\r\n{\\an8}（風の音）\r\n（鳥の声）\r\n\r\n2\r\n00:00:20,645 --> 00:00:23,732\r\n（商人）はい… はい\r\n\r\n3\r\n00:01:03,980 --> 00:01:05,982\r\n{\\an8}♪～\r\n\r\n4\r\n00:02:39,826 --> 00:02:41,619\r\n（高順(ガオシュン)）薬草(やくそう)… ですか\r\n\r\n5\r\n00:02:41,703 --> 00:02:42,787\r\n（壬氏(ジンシ)）そうだ\r\n\r\n6\r\n00:02:43,288 --> 00:02:46,249\r\n市場(いちば)で買った箱に\r\n入っていたものだ\r\n\r\n7\r\n00:02:50,000 --> 00:02:52,000\r\n猫猫に聞いてみよう 壬氏様\r\n\r\n`;

const ASS = `[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:03.10,0:00:05.61,Default,,0000,0000,0000,,{\\pos(332,377)\\fscx50}（\nDialogue: 0,0:00:03.10,0:00:05.61,Default,,0000,0000,0000,,{\\pos(352,377)}激しい風の音\nDialogue: 0,0:00:03.10,0:00:05.61,Default,,0000,0000,0000,,{\\pos(592,377)\\fscx50}）\nDialogue: 0,0:00:10.00,0:00:12.50,Default,,0,0,0,,猫猫、こっちだ\\N早く\nDialogue: 0,0:00:13.00,0:00:14.00,OP_Romaji,,0,0,0,,{\\k20}ma{\\k20}o\nDialogue: 0,0:00:15.00,0:00:16.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\n`;

const CHARACTERS = [
  { id: 155904, name: 'Maomao', russian: 'Маомао', japanese: '猫猫', synonyms: ['Xiaomao'], altNames: ['小猫'] },
  { id: 156096, name: 'Renshi', russian: 'Жэньши', japanese: '壬氏', synonyms: ['Jinshi '] },
  { id: 178876, name: 'Gaoshun', russian: 'Гаошунь', japanese: '高順', synonyms: ['Gaoshun '] },
  { id: 178877, name: 'Ah-Duo', russian: 'Адо', japanese: '阿多', synonyms: ['Ah-Duo '] },
  { id: 1, name: 'Tanjirou Kamado', russian: 'Тандзиро Камадо', japanese: '竈門 炭治郎' },
  { id: 2, name: 'Nezuko Kamado', russian: 'Нэдзуко Камадо', japanese: '竈門 禰豆子' },
  { id: 3, name: 'Noelle Silva', russian: 'Ноэль Сильва', japanese: 'ノエル・シルヴァ' },
  { id: 4, name: 'Mikasa Ackerman', russian: 'Микаса Аккерман', japanese: 'ミカサ・アッカーマン' },
  { id: 5, name: 'Rishu', russian: 'Лишу', japanese: '里樹妃' },
];

test('SRT: метки говорящих, фуригана, ремарки, музыка', () => {
  const { format, events } = parseSubtitle(CC_SRT, 'x.ja[cc].srt');
  assert.equal(format, 'srt');
  assert.equal(events.length, 7);
  assert.equal(events[0].speech, false); // только звуки
  assert.deepEqual(events[1].speakers, ['商人']);
  assert.equal(events[1].speech, true);
  assert.equal(events[2].speech, false); // ♪
  assert.deepEqual(events[3].speakers, ['高順']);
  assert.equal(events[3].text, '薬草… ですか');
  assert.equal(events[5].text, '市場で買った箱に 入っていたものだ');
  assert.equal(events[3].start, 159.826);
});

test('ASS: склейка фрагментов ТВ-записи, теги, OP и графика отбрасываются', () => {
  const { format, events } = parseSubtitle(ASS, 'x.ass');
  assert.equal(format, 'ass');
  assert.equal(events.length, 2);
  assert.equal(events[0].speech, false); // «（激しい風の音）» склеилось и ушло как ремарка
  assert.equal(events[1].text, '猫猫、こっちだ 早く');
});

test('cleanText: ремарка в начале без реплики — не говорящий', () => {
  assert.deepEqual(cleanText('（笑い声）').speakers, []);
  assert.deepEqual(cleanText('(マオマオ)はい').speakers, ['マオマオ']);
});

test('speechIntervals склеивает близкие реплики', () => {
  const iv = speechIntervals([
    { start: 1, end: 2, speech: true }, { start: 2.1, end: 3, speech: true },
    { start: 5, end: 6, speech: true }, { start: 7, end: 8, speech: false },
  ]);
  assert.deepEqual(iv, [[1, 3], [5, 6]]);
});

test('Имена: японские, с титулом, фамилия у двоих — не используется', () => {
  const m = buildMatcher(CHARACTERS);
  assert.deepEqual(matchText(m, '猫猫に聞いてみよう 壬氏様').map((x) => x.id).sort(), [155904, 156096]);
  assert.deepEqual(matchText(m, '炭治郎！').map((x) => x.id), [1]);
  assert.deepEqual(matchText(m, '竈門さん'), []); // фамилия общая у брата и сестры
  assert.deepEqual(matchText(m, '里樹様が').map((x) => x.id), [5]); // 里樹妃 → 里樹
  assert.deepEqual(matchText(m, 'ノエルが来た').map((x) => x.id), [3]);
  assert.deepEqual(matchText(m, 'ノエルヴァ'), []); // катакана внутри другого слова
  assert.deepEqual(matchText(m, '小猫').map((x) => x.id), [155904]); // альт. имя из AniList
});

test('Имена: латиница и кириллица с падежами', () => {
  const m = buildMatcher(CHARACTERS);
  assert.deepEqual(matchText(m, 'Where is Maomao?').map((x) => x.id), [155904]);
  assert.deepEqual(matchText(m, 'Ah Duo said').map((x) => x.id), [178877]);
  assert.deepEqual(matchText(m, 'Позови Микасу и Тандзиро').map((x) => x.id).sort(), [1, 4]);
  assert.deepEqual(matchText(m, 'Микасой'), [{ id: 4, token: 'Микасой' }]);
  assert.deepEqual(matchText(m, 'микроскоп'), []);
});

test('findMentions: упоминания и говорящие', () => {
  const m = buildMatcher(CHARACTERS);
  const { events } = parseSubtitle(CC_SRT, 'x.srt');
  const { mentions, speakers } = findMentions(events, m);
  assert.deepEqual(mentions.map((x) => x.id).sort(), [155904, 156096]);
  assert.deepEqual(speakers.map((x) => x.id), [178876, 156096]);
});

test('romajiKey сопоставляет варианты', () => {
  assert.equal(romajiKey('Ah-Duo'), romajiKey('Ah Duo'));
});

test('Номер серии из имени файла', () => {
  const cases = {
    '[NanakoRaws] Kusuriya no Hitorigoto S3 - 01 (CTV TV 1080p HEVC AAC).ass': 1,
    '[Nekomoe kissaten&LoliHouse] Kusuriya no Hitorigoto - 49 [WebRip 1080p HEVC-10bit AAC ASSx2][JPN].ass': 49,
    '[shincaps] Kusuriya no Hitorigoto 3rd Season - 02 (AT-X 1440x1080 MPEG2 AAC).srt': 2,
    '薬屋のひとりごと.S03E01.第49話.蝗（いなご）.WEBRip.Amazon.ja-jp[sdh].srt': 1,
    '薬屋のひとりごと.S03E49.蝗.WEBRip.Netflix.ja[cc].srt': 49,
    'Show.EP07.ja.srt': 7,
    '[Group] Show [05][1080p].ass': 5,
  };
  for (const [name, n] of Object.entries(cases)) assert.equal(episodeNumberFromName(name), n, name);
});

test('Выбор файла: сквозная нумерация и приоритеты', () => {
  const names = [
    '[NanakoRaws] Kusuriya no Hitorigoto S3 - 01 (CTV TV 1080p HEVC AAC).ass',
    '[NanakoRaws] Kusuriya no Hitorigoto S3 - 01 (CTV TV 1080p HEVC AAC).srt',
    '[NanakoRaws] Kusuriya no Hitorigoto S3 - 02 (CTV TV 1080p HEVC AAC).srt',
    '[NanakoRaws] Kusuriya no Hitorigoto S3 - 06 (CTV TV 1080p HEVC AAC).sup',
    '[Nekomoe kissaten&LoliHouse] Kusuriya no Hitorigoto - 49 [WebRip 1080p HEVC-10bit AAC ASSx2][CHS, JPN].ass',
    '[Nekomoe kissaten&LoliHouse] Kusuriya no Hitorigoto - 49 [WebRip 1080p HEVC-10bit AAC ASSx2][JPN].ass',
    '[Nekomoe kissaten&LoliHouse] Kusuriya no Hitorigoto - 50 [WebRip 1080p HEVC-10bit AAC ASSx2][JPN].ass',
    '薬屋のひとりごと.S03E49.蝗.WEBRip.Netflix.ja[cc].srt',
    '薬屋のひとりごと.S03E50.何か.WEBRip.Netflix.ja[cc].srt',
    '薬屋のひとりごと.S03E01.第49話.蝗（いなご）.WEBRip.Amazon.ja-jp[sdh].srt',
  ].map((name) => ({ name, url: `/dl/${encodeURIComponent(name)}`, size: 20000 }));
  const c1 = pickCandidates(names, 1, 12);
  const top = c1.map((c) => c.name);
  assert.ok(top[0].includes('Netflix') || top[0].includes('Amazon'), top[0]);
  assert.ok(top.includes(names[5].name));
  assert.ok(!top.some((n) => n.endsWith('.sup')));
  assert.ok(!top.some((n) => n.includes('S3 - 02') || n.includes('E50')));
  assert.equal(c1[c1.length - 1].name, names[4].name); // двуязычный — в конце
  const c2 = pickCandidates(names, 2, 12).map((c) => c.name);
  assert.ok(c2.some((n) => n.includes('E50')));
  assert.ok(c2.some((n) => n.includes('- 50')));
});

test('Синхронизация: находит сдвиг по зашумлённой маске речи', () => {
  // Субтитры: реплики случайной длины
  let t = 5;
  const iv = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  while (t < 1400) {
    const len = 0.8 + rnd() * 3;
    iv.push([t, t + len]);
    t += len + 0.3 + rnd() * (rnd() < 0.1 ? 20 : 3);
  }
  const trueOffset = 23.4;
  const est = new SyncEstimator(iv);
  // Шум: отрезки «ложной речи» (музыка, эффекты) и пропуски, 120 с просмотра
  const noise = [];
  for (let x = 300; x < 430; x += 2 + rnd() * 8) noise.push([x, x + 0.3 + rnd() * 2, rnd() < 0.6]);
  for (let v = 300; v < 420; v += 0.032) {
    const s = v - trueOffset;
    let speech = iv.some(([a, b]) => s >= a - 0.1 && s <= b + 0.5);
    const seg = noise.find(([a, b]) => v >= a && v <= b);
    if (seg) speech = seg[2];
    est.addFrame(v, speech ? 0.6 + rnd() * 0.4 : rnd() * 0.4);
  }
  const r = est.estimate();
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(Math.abs(r.offset - trueOffset) <= 0.5, JSON.stringify(r));
});

test('Синхронизация: без речи — не уверена', () => {
  const est = new SyncEstimator([[10, 12], [20, 25]]);
  for (let v = 0; v < 100; v += 0.032) est.addFrame(v, 0.1);
  assert.equal(est.estimate().ok, false);
});

test('OffsetTracker: фиксация после подтверждения, скачок — тоже', () => {
  const tr = new OffsetTracker(15); // сохранённый сдвиг с прошлой серии
  assert.equal(tr.push({ ok: true, offset: 20 }), null);
  assert.equal(tr.push({ ok: true, offset: 20.3 }), 20.3);
  assert.equal(tr.push({ ok: true, offset: 20.6 }), 20.6); // уточнение
  assert.equal(tr.push({ ok: true, offset: 50 }), null); // скачок
  assert.equal(tr.push({ ok: true, offset: 50.2 }), 50.2);
  assert.equal(tr.push({ ok: false }), null);
  const tr2 = new OffsetTracker();
  assert.equal(tr2.push({ ok: true, strong: true, offset: 7 }), 7);
});

test('Имена с титулами и суффиксами, два варианта имени, нарицательные «имена»', () => {
  const chars = [
    { id: 1, name: 'Renshi', russian: 'Жэньши', japanese: '壬氏' },
    { id: 2, name: 'Xiangyu', russian: 'Сянъюй', japanese: '響迂 / 趙迂' },
    { id: 3, name: 'Meimei', russian: 'Мэймэй', japanese: '梅梅' },
    { id: 4, name: 'Owner', russian: 'Владелец', japanese: 'お館さん' },
    { id: 5, name: 'Son-in-law', russian: 'Зять Юйюаня', japanese: '旦那' },
    { id: 6, name: 'Eldest son', russian: 'Старший сын', japanese: '長男' },
    { id: 7, name: 'Yuyuan sister', russian: 'Сестра Юйюаня', japanese: '虞淵妹' },
    { id: 8, name: 'Yuyuan', russian: 'Юйюань', japanese: '虞淵' },
  ];
  const m = buildMatcher(chars);
  const ids = (s) => matchText(m, s).map((x) => x.id).sort();
  assert.deepEqual(ids('それは 壬氏殿の命令だ'), [1]);
  assert.deepEqual(ids('趙迂は どこへ行った'), [2]);
  assert.deepEqual(ids('こんにちは 梅梅姐ちゃん'), [3]);
  assert.deepEqual(ids('明日 お館さんに会う'), [4]);
  assert.deepEqual(ids('旦那、長男はどこだ'), []);
  assert.deepEqual(ids('虞淵妹が来た'), [7]);
  assert.deepEqual(ids('虞淵が来た'), [8]);
});

import { cleanDescription } from '../extension/lib/desc.js';

test('Описание: убираем спойлеры и BBCode, обрезаем по предложению', () => {
  const raw = 'Лекарь при дворе [character=178866]императора[/character], служит ему много лет. Знает все травы.\r\n[spoiler=спойлер]На самом деле он шпион.[/spoiler] Любит чай.';
  assert.equal(cleanDescription(raw), 'Лекарь при дворе императора, служит ему много лет. Знает все травы. Любит чай.');
  assert.equal(cleanDescription('Выведший [character=155904 маомао] на чистую воду.'), 'Выведший Маомао на чистую воду.');
  assert.equal(cleanDescription('Текст. [spoiler]незакрытый спойлер до конца'), 'Текст.');
  const long = cleanDescription(`${'Первое предложение довольно длинное и подробное, с деталями. '.repeat(3)}Второе.`, 120);
  assert.ok(long.length <= 120 && long.endsWith('.'), long);
  assert.equal(cleanDescription(null), '');
});

import { parseAnimeRef } from '../extension/lib/refs.js';

test('Ручной выбор аниме: ссылки и ID', () => {
  assert.equal(parseAnimeRef('https://shikimori.io/animes/z61987-kusuriya-no-hitorigoto-3rd-season'), 61987);
  assert.equal(parseAnimeRef('https://shikimori.one/animes/52991-sousou-no-frieren'), 52991);
  assert.equal(parseAnimeRef('https://myanimelist.net/anime/61987/Kusuriya'), 61987);
  assert.equal(parseAnimeRef(' 61987 '), 61987);
  assert.equal(parseAnimeRef('Монолог фармацевта'), null);
  assert.equal(parseAnimeRef(''), null);
});
