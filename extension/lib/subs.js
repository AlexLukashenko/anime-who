// Разбор субтитров (SRT / VTT / ASS) и очистка текста реплик.
// На выходе — события {start, end, text, speakers, speech}, время в секундах.

const KANA = '\\p{Script=Hiragana}\\p{Script=Katakana}ー・･';
// «漢字(よみ)» → «漢字»: убираем фуригану в скобках после иероглифов
const RUBY_RE = new RegExp(`([\\p{Script=Han}々〆ヶ])[（(][${KANA}]+[）)]`, 'gu');
// Метка говорящего в начале строки: «（高順）…», «(壬氏)…», «［猫猫］…»
const SPEAKER_RE = /^[\s\-－‐―]*[（(［\[]([^（）()［\]\[]{1,24})[）)］\]]\s*/u;
const BRACKETS_RE = /[（(［\[【〔][^（）()［\]\[【】〔〕]*[）)］\]】〕]/gu;
const MUSIC_RE = /[♪♫♬]/u;
const LETTER_RE = /[\p{L}\p{N}]/u;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseTimestamp(ts) {
  // 00:00:04,504 | 00:04.504 | 0:00:04.50 (ASS)
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4] ? Number(m[4]) / 10 ** m[4].length : 0;
  return h * 3600 + min * 60 + s + frac;
}

export function detectFormat(text, filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return 'ass';
  if (lower.endsWith('.vtt')) return 'vtt';
  if (lower.endsWith('.srt')) return 'srt';
  if (/^\s*\[Script Info\]/im.test(text) || /^Dialogue:/m.test(text)) return 'ass';
  if (/^WEBVTT/.test(text)) return 'vtt';
  return 'srt';
}

export function parseSrt(text) {
  const out = [];
  const blocks = stripBom(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(b.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const body = lines.slice(idx + 1).join('\n').trim();
    if (body) out.push({ start, end, raw: body });
  }
  return out;
}

export function parseAss(text) {
  const out = [];
  const lines = stripBom(text).replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let format = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = /^\[Events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(trimmed)) {
      format = trimmed.slice(7).split(',').map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed)) continue;
    const fields = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const rest = trimmed.replace(/^Dialogue:\s*/i, '');
    const parts = [];
    let pos = 0;
    for (let i = 0; i < fields.length - 1; i++) {
      const comma = rest.indexOf(',', pos);
      if (comma < 0) break;
      parts.push(rest.slice(pos, comma));
      pos = comma + 1;
    }
    parts.push(rest.slice(pos));
    const rec = {};
    fields.forEach((f, i) => { rec[f] = parts[i] ?? ''; });
    const raw = rec.text || '';
    if (/\\p[1-9]/.test(raw)) continue; // векторная графика
    const start = parseTimestamp(rec.start || '');
    const end = parseTimestamp(rec.end || '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const style = (rec.style || '').toLowerCase();
    if (/^(op|ed)(\b|_|\d)|[-_ ](op|ed)$|sign|karaoke|^kara|song|lyric|title/.test(style)) continue;
    const body = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ');
    out.push({ start, end, raw: body, layer: rec.layer, actor: rec.name || '' });
  }
  // ТВ-записи режут одну реплику на несколько событий с одинаковым временем — склеиваем.
  const merged = [];
  const byKey = new Map();
  for (const ev of out) {
    const key = `${ev.start.toFixed(2)}|${ev.end.toFixed(2)}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.raw += ev.raw;
    } else {
      const copy = { ...ev };
      byKey.set(key, copy);
      merged.push(copy);
    }
  }
  merged.sort((x, y) => x.start - y.start);
  return merged;
}

/** Очищает строку: убирает теги, фуригану, ремарки; вытаскивает метки говорящих. */
export function cleanText(raw) {
  const speakers = [];
  let music = false;
  const outLines = [];
  const lines = raw.replace(/\{[^}]*\}/g, '').replace(/<[^>]+>/g, '').split('\n');
  for (let line of lines) {
    line = line.replace(RUBY_RE, '$1').trim();
    if (!line) continue;
    if (MUSIC_RE.test(line)) { music = true; continue; }
    let m;
    while ((m = line.match(SPEAKER_RE))) {
      const label = m[1].trim();
      const rest = line.slice(m[0].length);
      // Метка говорящего — только если после неё есть реплика; иначе это ремарка «（笑い声）»
      if (rest.trim() && LETTER_RE.test(rest)) speakers.push(label);
      line = rest;
    }
    line = line.replace(BRACKETS_RE, ' ').replace(/\s+/g, ' ').trim();
    if (line) outLines.push(line);
  }
  const text = outLines.join(' ');
  return { text, speakers, music, speech: !music && LETTER_RE.test(text) };
}

export function parseSubtitle(text, filename = '') {
  const fmt = detectFormat(text, filename);
  const rawEvents = fmt === 'ass' ? parseAss(text) : parseSrt(text.replace(/^WEBVTT[^\n]*\n/, ''));
  const events = [];
  for (const ev of rawEvents) {
    if (ev.end <= ev.start) continue;
    const c = cleanText(ev.raw);
    const speakers = c.speakers.slice();
    if (ev.actor && !speakers.includes(ev.actor)) speakers.push(ev.actor);
    events.push({ start: ev.start, end: ev.end, text: c.text, speakers, speech: c.speech });
  }
  return { format: fmt, events };
}

/** Интервалы речи (склеенные) — для синхронизации по звуку. */
export function speechIntervals(events, gap = 0.25) {
  const iv = events.filter((e) => e.speech).map((e) => [e.start, e.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + gap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.map(([s, e]) => [Math.round(s * 100) / 100, Math.round(e * 100) / 100]);
}
