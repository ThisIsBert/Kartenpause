import { getLanguage, setLanguage } from './i18n.js';

export function setupSettings() {
  const dialog = document.getElementById('settingsDialog');
  const select = document.getElementById('languageSelect');
  select.value = getLanguage();
  document.getElementById('openSettings').addEventListener('click', () => {
    select.value = getLanguage();
    dialog.showModal();
  });
  select.addEventListener('change', () => setLanguage(select.value));
  // Dialog keys must not trigger drawing shortcuts behind the modal.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
}
