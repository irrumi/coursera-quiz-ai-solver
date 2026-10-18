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

    function normalizeAnswers(answers) {
        if (!Array.isArray(answers)) return [];
        return answers.filter(item => item && Number.isInteger(Number(item.q))).map(item => {
            const value = item.a ?? item.text;
            const values = Array.isArray(value) ? value : [value];
            return { ...item, q: Number(item.q), a: values.filter(v => typeof v === 'string' || typeof v === 'number').map(String) };
        });
    }

    function hasCompleteResponseEnvelope(text) {
        if (!/"answers"\s*:/.test(text)) return true;
        return extractJsonObjects(text).some(candidate => /"answers"\s*:/.test(candidate));
    }

    function isVisible(element) {
        if (!element || element.hidden || element.closest?.('[hidden], [aria-hidden="true"]')) return false;
        const style = root.getComputedStyle?.(element);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) {
            return style?.display === 'contents' && [...element.children].some(isVisible);
        }
        return true;
    }

    // React can update a response in place, or remount old messages with new nodes.
    // Track both identity and text so either case is handled without reading an old reply.
    function createResponseTracker(getElements) {
        const initial = getElements();
        const textOf = el => (el.innerText || el.textContent || '').trim();
        const nodes = new Map(initial.map(el => [el, textOf(el)]));
        const ids = new Map(initial.map(el => [el.getAttribute('data-message-id'), textOf(el)]).filter(([id]) => id));
        const oldTexts = new Set(nodes.values());
        return () => {
            const all = getElements();
            const fresh = all.filter(el => {
                const text = textOf(el), id = el.getAttribute('data-message-id');
                if (id && ids.has(id)) return ids.get(id) !== text;
                if (nodes.has(el)) return nodes.get(el) !== text;
                return !!id || all.length > initial.length || !oldTexts.has(text);
            });
            const outer = fresh.filter(el => !fresh.some(other => other !== el && other.contains?.(el)));
            return outer.map(textOf).filter(Boolean).join('\n\n');
        };
    }

    function isProviderProcessing(provider, text) {
        const doc = root.document;
        const controls = doc.querySelectorAll('button[data-testid="stop-button"], button[aria-label], [data-is-streaming="true"]');
        for (const element of controls) {
            if (!isVisible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
            if (element.getAttribute('data-is-streaming') === 'true' || element.getAttribute('data-testid') === 'stop-button') return true;
            if (/^(stop|stop generating|stop generation|stop response|остановить|остановить генерацию)$/i.test((element.getAttribute('aria-label') || '').trim())) return true;
        }
        if ((text || '').length > 180) return false;
        return provider === 'chatgpt'
            ? /^(analyzing|thinking|searching(?: the)? web|running analysis)[.\s…]*$/i.test(text || '')
            : /taking longer than usual|trying again shortly|attempt\s+\d+/i.test(text || '');
    }

    function waitForStoredAnswer({ answerKey, progressKey, taskId, timeoutMs, isCancelled = () => false, onProgress = () => {} }) {
        return new Promise((resolve, reject) => {
            let finished = false, interval, timeout;
            const finish = (error, value) => {
                if (finished) return;
                finished = true;
                clearInterval(interval);
                clearTimeout(timeout);
                chrome.storage.onChanged.removeListener(listener);
                if (error) reject(error); else resolve(value);
            };
            const consume = data => {
                if (isCancelled()) return finish(new Error('AI task cancelled.'));
                const progress = data[progressKey];
                if (progress?.taskId === taskId) onProgress(progress);
                if (data[answerKey]?.taskId === taskId) finish(null, data[answerKey]);
            };
            const poll = () => chrome.storage.local.get([answerKey, progressKey]).then(consume).catch(error => finish(error));
            const listener = (changes, area) => {
                if (area !== 'local') return;
                consume(Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])));
            };
            chrome.storage.onChanged.addListener(listener);
            interval = setInterval(poll, 2000);
            timeout = setTimeout(() => finish(new Error('AI response timed out. Open Debug to see the last bridge stage.')), Math.max(0, timeoutMs));
            poll();
        });
    }

    // Read the full response only after generation stops and the text settles.
    // A timeout rejects; it never returns a partially streamed answer.
    function waitForResponse(getText, {
        timeoutMs = DEFAULT_SETTINGS.responseTimeoutSeconds * 1000,
        isProcessing = () => false,
        isComplete = () => true,
        isCancelled = () => false,
        stableMs = 3000,
        onProgress = () => {},
        target = root.document?.body,
    } = {}) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + Math.max(0, timeoutMs);
            let lastText = '', changedAt = Date.now(), interval, timeout, observer, lastProgress = -Infinity;
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
                    if (Date.now() - lastProgress >= 2000) {
                        lastProgress = Date.now();
                        onProgress({ stage: !text ? 'waiting_for_response' : processing ? 'generating' : 'response_detected', characters: text.length });
                    }
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
        saveSettings, runWithProviders, extractJsonObjects, hasCompleteAnswers, waitForResponse,
        normalizeAnswers, hasCompleteResponseEnvelope, isVisible, createResponseTracker, isProviderProcessing, waitForStoredAnswer });
})(globalThis);
