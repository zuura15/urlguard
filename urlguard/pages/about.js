// About page: global overlay guard switch.
const box = document.getElementById('overlay-global');
if (box) {
  chrome.runtime.sendMessage({ type: 'GET_OVERLAY_SETTINGS', site: '' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    box.checked = !!res.globalEnabled;
  });
  box.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'SET_OVERLAY_GUARD_GLOBAL', enabled: box.checked }, () => void chrome.runtime.lastError);
  });
}
