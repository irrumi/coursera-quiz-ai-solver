// popup.js — v6.1.3 Web UI
globalThis.CqsDebug?.attach('popup');

const solveAllBtn = document.getElementById('solve-all-btn');
const autoSolveBtn = document.getElementById('auto-solve-btn');
const providerButtons = [...document.querySelectorAll('[data-provider]')];
const responseTimeout = document.getElementById('response-timeout');
let selectedSettings = CqsAI.normalizeSettings();
function showPopupError(error) {
    document.getElementById('status-text').textContent = error.message || String(error);
    globalThis.CqsDebug?.log('popup', 'action_failed', { message: error.message || String(error) }, 'error');
}

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
}).catch(error => { showPopupError(error); throw error; });
settingsReady.catch(() => {});

function persistSettings() {
    const settings = { ...selectedSettings };
    renderSettings();
    settingsReady = settingsReady.catch(() => {}).then(() => CqsAI.saveSettings(settings));
    settingsReady.catch(showPopupError);
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

async function trigger(button, message) {
    button.disabled = true;
    try {
        await settingsReady;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !/^https:\/\/([\w-]+\.)?coursera\.org\//.test(tab.url || '')) throw new Error('Open a Coursera course tab first.');
        let ping;
        try { ping = await chrome.tabs.sendMessage(tab.id, { type: 'CQS_CONTENT_PING' }); } catch { /* Reconnect tabs opened before extension installation/reload. */ }
        if (!ping?.ok || ping.version !== chrome.runtime.getManifest().version) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['ai_common.js', 'diagnostics.js', 'quiz_scan.js', 'content.js'] });
        }
        const response = await chrome.tabs.sendMessage(tab.id, message);
        if (!response?.ok) throw new Error(response?.error || 'Coursera content script did not respond. Refresh the page.');
        document.getElementById('status-text').textContent = message.phase === 'scan_quizzes' ? 'Scanning quizzes...' : 'Started on Coursera';
    } catch (error) { showPopupError(error); }
    finally { button.disabled = false; }
}

solveAllBtn.addEventListener('click', () => trigger(solveAllBtn, { type: 'TRIGGER_SOLVE_ALL' }));
autoSolveBtn.addEventListener('click', () => trigger(autoSolveBtn, { type: 'TRIGGER_START', phase: 'collect_quizzes' }));
const scanButton = document.getElementById('scan-quizzes-btn');
scanButton.addEventListener('click', () => trigger(scanButton, { type: 'TRIGGER_START', phase: 'scan_quizzes' }));
document.getElementById('debug-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DEBUG' }).catch(showPopupError);
});
