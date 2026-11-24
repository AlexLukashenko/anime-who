// Определение номера серии по имени файла субтитров и выбор лучшего файла.

const SUB_EXT_RE = /\.(srt|ass|ssa|vtt)$/i;

const PATTERNS = [
  /S\d{1,2}E(\d{1,4})(?!\d)/i,
  /第\s*(\d{1,4})\s*[話话集]/,
  /(?:^|[\s_\-[(.])(?:EP?|Episode)\.?\s?(\d{1,4})(?=$|[\s_\-\]).v])/i,
  /\s[-–]\s(\d{1,4})(?:v\d)?(?=$|[\s[(.])/,
  /\[(\d{1,4})(?:v\d)?\]/,
  /[\s_.](\d{2,3})(?:v\d)?(?=[\s_.[(])/,
];

export function episodeNumberFromName(filename) {
  const base = filename.replace(/^.*\//, '').replace(/\.[a-z0-9]{2,4}$/i, '');
  for (const re of PATTERNS) {
    const m = base.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Приводит номера файлов к номеру серии внутри сезона.
 * Если встречаются «сквозные» номера (49, 50… при 12 сериях в сезоне),
 * вычитаем смещение = минимальный сквозной номер − 1.
 */
export function assignEpisodes(files, seasonEpisodes) {
  const nums = files.map((f) => episodeNumberFromName(f.name));
  const limit = seasonEpisodes && seasonEpisodes > 0 ? seasonEpisodes : null;
  let offset = 0;
  if (limit) {
    const absolute = nums.filter((n) => n != null && n > limit);
    if (absolute.length) offset = Math.min(...absolute) - 1;
  }
  return files.map((f, i) => {
    const n = nums[i];
    let episode = n;
    if (n != null && limit && n > limit && offset > 0) episode = n - offset;
    return { ...f, rawNumber: n, episode };
  });
}

export function scoreFile(name) {
  const lower = name.toLowerCase();
  let score = 0;
  if (lower.endsWith('.srt')) score += 30;
  else if (lower.endsWith('.ass') || lower.endsWith('.ssa')) score += 22;
  else if (lower.endsWith('.vtt')) score += 18;
  if (/netflix|amazon|amzn|abema|hulu|u-?next|disney|crunchyroll|webrip|web-?dl|\bweb\b|\bnf\b|bilibili|baha|danime|dアニメ|prime/i.test(name)) score += 10;
  if (/\bjpn\b|\bja\b|\bjp\b|ja-jp|\[jpn\]|日本語/i.test(name)) score += 4;
  if (/\[(cc|sdh)\]|\bcc\b|\bsdh\b/i.test(name)) score += 2;
  if (/\bchs\b|\bcht\b|\bsc\b|\btc\b|简|繁|big5|\bgb\b|\bchi\b|\bzh\b|\beng?\b|english|bilingual/i.test(name)) score -= 50;
  return score;
}

/** Кандидаты для серии, лучшие первыми. */
export function pickCandidates(files, episode, seasonEpisodes) {
  const subs = files.filter((f) => SUB_EXT_RE.test(f.name));
  const withEp = assignEpisodes(subs, seasonEpisodes);
  const single = withEp.length > 0 && withEp.every((f) => f.episode == null);
  return withEp
    .filter((f) => f.episode === episode || (single && episode <= 1))
    .map((f) => ({ ...f, score: scoreFile(f.name) - (f.size && f.size < 3000 ? 20 : 0) }))
    .sort((a, b) => b.score - a.score);
}
