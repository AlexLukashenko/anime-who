// Настройки по умолчанию (дублируются в content/player.js — content scripts не умеют import).
export const SETTINGS_DEFAULTS = {
  enabled: true,
  // кого показывать
  showMain: true, // главные герои
  showSupporting: true, // второстепенные
  showSpeakers: false, // «кто говорит», если в субтитрах есть метки говорящих
  noSpoilers: false, // в панели — только тех, кого уже называли в этой или прошлых сериях
  // что показывать в баннере
  fPhoto: true,
  fRu: true, // имя по-русски
  fJp: true, // имя иероглифами
  fRomaji: false, // имя латиницей
  fRole: true, // главный / второстепенный
  fTag: true, // пометка «упомянут» / «говорит»
  fToken: false, // как назвали в реплике (по-японски)
  fDesc: false, // краткое описание с Shikimori (может спойлерить)
  // поведение баннера
  bannerSeconds: 6,
  cooldownSeconds: 180, // не показывать одного и того же персонажа чаще
  position: 'top-left', // top-left | top-right
  // тайминги
  autoSync: true, // подбирать задержку по звуку (баннеры при этом идут с текущей задержкой)
  startDelay: 0, // задержка субтитров по умолчанию, секунд (заставка студии озвучки)
  jimakuKey: '', // необязательный API-ключ Jimaku
};
