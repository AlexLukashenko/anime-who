import { SETTINGS_DEFAULTS } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const settings = { ...SETTINGS_DEFAULTS, ...(await chrome.storage.sync.get(SETTINGS_DEFAULTS)) };

for (const [key, def] of Object.entries(SETTINGS_DEFAULTS)) {
  const el = $(key);
  if (!el) continue;
  if (typeof def === 'boolean') el.checked = settings[key];
  else el.value = settings[key];
  el.addEventListener('change', () => {
    let v;
    if (typeof def === 'boolean') v = el.checked;
    else if (typeof def === 'number') v = Number(el.value) || def;
    else v = el.value.trim();
    chrome.storage.sync.set({ [key]: v });
  });
}

$('clear').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'clear-cache' });
  $('clearMsg').textContent = r?.ok ? `Удалено записей: ${r.removed}` : 'Не получилось';
});
