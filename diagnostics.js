(function (root) {
    'use strict';
    const LOG_KEY = 'cqsDebugLog';
    const allowed = new Set(['taskId', 'timestamp', 'provider', 'stage', 'code', 'message', 'characters', 'answers', 'expected', 'missing', 'total', 'completed', 'pending', 'failed', 'locked', 'unknown', 'waiting', 'index', 'tabId', 'version', 'phase', 'readyState', 'editorFound', 'visibleEditors', 'responseNodes']);
    let writes = Promise.resolve();
    function sanitize(details = {}) {
        return Object.fromEntries(Object.entries(details).filter(([key, value]) => allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof value))
            .map(([key, value]) => [key, typeof value === 'string' ? value.replace(/https?:\/\/[^\s"'<>]+/g, '[url]').slice(0, 400) : value]));
    }
    function record(entry) {
        writes = writes.catch(() => {}).then(async () => {
            const data = await chrome.storage.local.get([LOG_KEY]);
            const log = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
            log.push({ timestamp: Date.now(), source: String(entry.source).slice(0, 30), event: String(entry.event).slice(0, 60),
                level: entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info', details: sanitize(entry.details) });
            await chrome.storage.local.set({ [LOG_KEY]: log.slice(-250) });
        });
        return writes;
    }
    function log(source, event, details = {}, level = 'info') {
        const entry = { source, event, details: sanitize(details), level };
        console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[QuizAI]', source, event, entry.details);
        try {
            const sent = chrome.runtime.sendMessage({ type: 'CQS_DEBUG_EVENT', entry });
            sent?.catch?.(() => {});
        } catch { /* The console still shows errors after an extension reload. */ }
    }
    function attach(source) {
        let layoutWarningReported = false;
        root.addEventListener?.('unhandledrejection', event => log(source, 'unhandled_rejection', { message: event.reason?.message || String(event.reason) }, 'error'));
        root.addEventListener?.('error', event => {
            const message = event.message || 'Script error';
            if (/^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/.test(message)) {
                if (!layoutWarningReported) log(source, 'page_layout_warning', { message: 'ResizeObserver layout warning; repeated warnings suppressed.' }, 'warn');
                layoutWarningReported = true;
                return;
            }
            log(source, 'script_error', { message }, 'error');
        });
    }
    async function report() {
        const data = await chrome.storage.local.get([LOG_KEY, 'cqsQuizScan', 'cqsAutoState', 'cqsLastQueue', 'cqsChatGptProgress', 'cqsClaudeProgress']);
        const saved = await chrome.storage.sync.get(['settings']);
        const scan = data.cqsQuizScan;
        const state = data.cqsAutoState;
        return {
            version: chrome.runtime.getManifest().version,
            generatedAt: new Date().toISOString(),
            settings: { provider: saved.settings?.provider || 'chatgpt', responseTimeoutSeconds: saved.settings?.responseTimeoutSeconds || 600 },
            queue: state ? { active: state.active, phase: state.phase, index: state.currentIndex, total: state.quizUrls?.length, lastError: state.lastError } : null,
            scan: scan ? { timestamp: scan.timestamp, counts: scan.counts, items: scan.items.map((item, index) => ({ index: index + 1, status: item.status, reason: item.reason, queued: item.queued })) } : null,
            providers: { chatgpt: data.cqsChatGptProgress ? sanitize(data.cqsChatGptProgress) : null, claude: data.cqsClaudeProgress ? sanitize(data.cqsClaudeProgress) : null },
            lastQueue: data.cqsLastQueue || null,
            events: data[LOG_KEY] || [],
        };
    }
    root.CqsDebug = Object.freeze({ log, attach, record, report, sanitize });
})(globalThis);
