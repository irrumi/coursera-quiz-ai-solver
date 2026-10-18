// popup.js — v6.1.2 Web UI

const solveAllBtn = document.getElementById('solve-all-btn');
const autoSolveBtn = document.getElementById('auto-solve-btn');
const providerButtons = [...document.querySelectorAll('[data-provider]')];
const responseTimeout = document.getElementById('response-timeout');
let selectedSettings = CqsAI.normalizeSettings();

function renderSettings() {
    providerButtons.forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.provider === selectedSettings.provider));
    });
    responseTimeout.value = String(selectedSettings.responseTimeoutSeconds);
    document.getElementById('provider-help').textContent = selectedSettings.provider === 'auto'
        ? 'Tries ChatGPT, then Claude if ChatGPT fails.'
        : `Uses ${selectedSettings.provider === 'claude' ? 'Claude' : 'ChatGPT'} only. No automatic switch.`;
}

solveAllBtn.disabled = autoSolveBtn.disabled = true;
let settingsReady = CqsAI.getSettings().then(settings => {
    selectedSettings = settings;
    renderSettings();
    providerButtons.forEach(button => { button.disabled = false; });
    responseTimeout.disabled = false;
    solveAllBtn.disabled = autoSolveBtn.disabled = false;
});

function persistSettings() {
    const settings = { ...selectedSettings };
    renderSettings();
    settingsReady = settingsReady.then(() => CqsAI.saveSettings(settings));
}

providerButtons.forEach(button => button.addEventListener('click', () => {
    selectedSettings.provider = button.dataset.provider;
    persistSettings();
}));
responseTimeout.addEventListener('change', () => {
    selectedSettings.responseTimeoutSeconds = Number(responseTimeout.value);
    persistSettings();
});
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync' || !changes.settings) return;
    selectedSettings = CqsAI.normalizeSettings(changes.settings.newValue);
    renderSettings();
});

// ── Answer this quiz only (Single Quiz Solve) ─────────────────────────────────
solveAllBtn.addEventListener('click', async () => {
    await settingsReady;
    const orig = solveAllBtn.innerHTML;
    solveAllBtn.disabled = true;
    solveAllBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Starting solver...`;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs[0]) { restore(); return; }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_SOLVE_ALL' }, () => {
            if (chrome.runtime.lastError) {
                // If content script isn't running
                console.error(chrome.runtime.lastError);
            }
            setTimeout(restore, 3000);
        });
    });
    function restore() { solveAllBtn.disabled = false; solveAllBtn.innerHTML = orig; }
});

// ── Auto-solve all assignments (Pipeline) ──────────────────────────────────────
autoSolveBtn.addEventListener('click', async () => {
    await settingsReady;
    const orig = autoSolveBtn.innerHTML;
    autoSolveBtn.disabled = true;
    autoSolveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Starting pipeline...`;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs[0]) { restore(); return; }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_START' }, () => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
            }
            setTimeout(restore, 3000);
        });
    });
    function restore() { autoSolveBtn.disabled = false; autoSolveBtn.innerHTML = orig; }
});
