// Shared settings and response handling for the extension's web providers.
(function (root) {
    'use strict';

    const DEFAULT_SETTINGS = Object.freeze({ provider: 'chatgpt', responseTimeoutSeconds: 600 });
    const TIMEOUT_OPTIONS = Object.freeze([300, 600, 1200, 1800]);

    function normalizeSettings(settings = {}) {
        return {
            provider: ['chatgpt', 'claude', 'auto'].includes(settings?.provider)
                ? settings.provider : DEFAULT_SETTINGS.provider,
            responseTimeoutSeconds: TIMEOUT_OPTIONS.includes(Number(settings?.responseTimeoutSeconds))
                ? Number(settings.responseTimeoutSeconds) : DEFAULT_SETTINGS.responseTimeoutSeconds,
        };
    }

    async function getSettings() {
        const data = await chrome.storage.sync.get(['settings']);
        return normalizeSettings(data.settings);
    }

    async function saveSettings(patch) {
        const data = await chrome.storage.sync.get(['settings']);
        const settings = { ...data.settings, ...patch };
        Object.assign(settings, normalizeSettings(settings));
        await chrome.storage.sync.set({ settings });
        return normalizeSettings(settings);
    }

    async function runWithProviders(provider, solve, onFallback = () => {}) {
        const choice = normalizeSettings({ provider }).provider;
        const providers = choice === 'auto' ? ['chatgpt', 'claude'] : [choice];
        for (let i = 0; i < providers.length; i++) {
            if (i > 0) await onFallback(providers[i]);
            if (await solve(providers[i])) return true;
        }
        return false;
    }

    // Braces inside quoted prose/code/SVG must not terminate the JSON object.
    function extractJsonObjects(text) {
        const results = [];
        let depth = 0, start = -1, inString = false, escaped = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (depth > 0 && char === '"') inString = true;
            else if (char === '{') {
                if (depth === 0) start = i;
                depth++;
            } else if (char === '}' && depth > 0) {
                depth--;
                if (depth === 0) {
                    results.push(text.slice(start, i + 1));
                    start = -1;
                }
            }
        }
        return results;
    }

    function hasCompleteAnswers(answers, expectedCount) {
        if (!Array.isArray(answers) || answers.length === 0) return false;
        const answered = new Set(answers.filter(item =>
            item && Array.isArray(item.a) && item.a.length > 0 &&
            item.a.every(value => typeof value === 'string' && value.trim().length > 0)
        ).map(item => Number(item.q)));
        if (!Number.isInteger(expectedCount) || expectedCount < 1) return answered.size > 0;
        for (let q = 1; q <= expectedCount; q++) {
            if (!answered.has(q)) return false;
        }
        return true;
    }

    // Read the full response only after generation stops and the text settles.
    // A timeout rejects; it never returns a partially streamed answer.
    function waitForResponse(getText, {
        timeoutMs = DEFAULT_SETTINGS.responseTimeoutSeconds * 1000,
        isProcessing = () => false,
        isComplete = () => true,
        isCancelled = () => false,
        stableMs = 3000,
        target = root.document?.body,
    } = {}) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + Math.max(0, timeoutMs);
            let lastText = '', changedAt = Date.now(), interval, timeout, observer;
            let finished = false;

            function finish(error, text) {
                if (finished) return;
                finished = true;
                clearInterval(interval);
                clearTimeout(timeout);
                observer?.disconnect();
                if (error) reject(error);
                else resolve(text);
            }

            function check() {
                if (finished) return;
                try {
                    if (isCancelled()) return finish(new Error('AI task cancelled.'));
                    if (Date.now() >= deadline) return finish(new Error('AI response timed out. Increase the response wait time and try again.'));
                    const text = getText() || '';
                    const processing = isProcessing(text);
                    if (text !== lastText || processing) {
                        lastText = text;
                        changedAt = Date.now();
                    }
                    if (text.trim() && !processing && Date.now() - changedAt >= stableMs && isComplete(text)) {
                        finish(null, text);
                    }
                } catch (error) {
                    finish(error);
                }
            }

            interval = setInterval(check, 800);
            timeout = setTimeout(check, Math.max(0, timeoutMs));
            if (target && typeof root.MutationObserver === 'function') {
                observer = new root.MutationObserver(check);
                observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
            }
            check();
        });
    }

    root.CqsAI = Object.freeze({ DEFAULT_SETTINGS, TIMEOUT_OPTIONS, normalizeSettings, getSettings,
        saveSettings, runWithProviders, extractJsonObjects, hasCompleteAnswers, waitForResponse });
})(globalThis);
