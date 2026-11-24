// Разбор ручного ввода «какое аниме»: ссылка на Shikimori / MyAnimeList или просто число.
// «https://shikimori.io/animes/z61987-kusuriya…», «myanimelist.net/anime/61987», «61987» → 61987
export function parseAnimeRef(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/myanimelist\.net\/anime\/(\d+)/) || s.match(/\/animes\/[a-z]*(\d+)/) || s.match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}
