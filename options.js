// options.js — Settings page controller
// (Must be a separate file — inline scripts are blocked by Chrome Extension CSP)

const DEFAULT_SETTINGS = {
    ...CqsAI.DEFAULT_SETTINGS,
    language: 'English',
    showConfidence: true,
    showReasoning: true,
    highlight: true,
    autoSolve: false
};

// Load saved settings
chrome.storage.sync.get(['settings'], (data) => {
    const s = data.settings || {};
    const aiSettings = CqsAI.normalizeSettings(s);
    document.getElementById('opt-provider').value = aiSettings.provider;
    document.getElementById('opt-response-timeout').value = String(aiSettings.responseTimeoutSeconds);
    if (s.language) document.getElementById('opt-language').value = s.language;
    if (s.showConfidence !== undefined) document.getElementById('opt-show-confidence').checked = s.showConfidence;
    if (s.showReasoning !== undefined) document.getElementById('opt-show-reasoning').checked = s.showReasoning;
    if (s.highlight !== undefined) document.getElementById('opt-highlight').checked = s.highlight;
    if (s.autoSolve !== undefined) document.getElementById('opt-auto-solve').checked = s.autoSolve;
});

// Save settings
document.getElementById('save-all-btn').addEventListener('click', async () => {
    const settings = {
        provider: document.getElementById('opt-provider').value,
        responseTimeoutSeconds: Number(document.getElementById('opt-response-timeout').value),
        language: document.getElementById('opt-language').value,
        showConfidence: document.getElementById('opt-show-confidence').checked,
        showReasoning: document.getElementById('opt-show-reasoning').checked,
        highlight: document.getElementById('opt-highlight').checked,
        autoSolve: document.getElementById('opt-auto-solve').checked
    };
    await CqsAI.saveSettings(settings);
    const msg = document.getElementById('saved-msg');
    msg.classList.add('show');
    setTimeout(() => msg.classList.remove('show'), 3000);
});
