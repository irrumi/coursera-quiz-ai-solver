const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const project = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(project, name), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(extra = {}) {
    let now = 0, nextId = 0;
    const timers = new Map(), listeners = [], observers = new Set();
    const local = {}, sync = {};
    function schedule(fn, ms, repeat) {
        const id = ++nextId;
        timers.set(id, { fn, at: now + Math.max(1, ms), repeat });
        return id;
    }
    const storage = (data, namespace) => ({
        async get(keys, callback) {
            const result = Object.fromEntries(keys.map(key => [key, data[key]]));
            callback?.(result);
            return result;
        },
        async set(values, callback) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                changes[key] = { oldValue: data[key], newValue: value };
                data[key] = value;
            }
            listeners.forEach(listener => listener(changes, namespace));
            callback?.();
        },
        async remove(keys, callback) {
            const changes = {};
            for (const key of keys) {
                changes[key] = { oldValue: data[key] };
                delete data[key];
            }
            listeners.forEach(listener => listener(changes, namespace));
            callback?.();
        },
    });
    class FakeDate extends Date { static now() { return now; } }
    class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
    const context = vm.createContext({
        Date: FakeDate,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn, ms) => schedule(fn, ms, 0),
        setInterval: (fn, ms) => schedule(fn, ms, ms),
        clearTimeout: id => timers.delete(id),
        clearInterval: id => timers.delete(id),
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() { observers.add(this); }
            disconnect() { observers.delete(this); }
        },
        Event, InputEvent: Event, KeyboardEvent: Event, FocusEvent: Event,
        chrome: {
            storage: { local: storage(local, 'local'), sync: storage(sync, 'sync'), onChanged: { addListener: fn => listeners.push(fn) } },
            runtime: { onMessage: { addListener() {} } },
        },
        ...extra,
    });
    vm.runInContext(read('ai_common.js'), context);
    async function advance(ms) {
        await flush();
        const end = now + ms;
        for (;;) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.repeat) timer.at += timer.repeat;
            else timers.delete(id);
            timer.fn();
            await flush();
        }
        now = end;
        await flush();
    }
    return { context, api: context.CqsAI, local, sync, timers, observers, advance,
        notify: () => [...observers].forEach(observer => observer.callback()) };
}

test('default is ChatGPT only with a ten-minute response wait', () => {
    const { api } = harness();
    assert.equal(api.normalizeSettings().provider, 'chatgpt');
    assert.equal(api.normalizeSettings().responseTimeoutSeconds, 600);
    assert.equal(api.normalizeSettings({ provider: 'unknown', responseTimeoutSeconds: 'NaN' }).provider, 'chatgpt');
    assert.equal(api.normalizeSettings({ provider: 'claude', responseTimeoutSeconds: '1800' }).responseTimeoutSeconds, 1800);
});

test('provider and timeout persist while preserving existing preferences', async () => {
    const { api, sync } = harness();
    sync.settings = { language: 'English', highlight: false };
    await api.saveSettings({ provider: 'claude', responseTimeoutSeconds: 1200 });
    assert.equal((await api.getSettings()).provider, 'claude');
    assert.equal((await api.getSettings()).responseTimeoutSeconds, 1200);
    assert.equal(sync.settings.highlight, false);
    assert.equal(sync.settings.language, 'English');
});

for (const provider of ['chatgpt', 'claude']) {
    test(`${provider} only never falls back after failure`, async () => {
        const { api } = harness(), calls = [];
        const result = await api.runWithProviders(provider, async selected => { calls.push(selected); return false; });
        assert.equal(result, false);
        assert.deepEqual(calls, [provider]);
    });
}

test('Auto tries Claude only after a failed ChatGPT attempt', async () => {
    const { api } = harness(), calls = [];
    assert.equal(await api.runWithProviders('auto', async provider => {
        calls.push(provider);
        return provider === 'claude';
    }), true);
    assert.deepEqual(calls, ['chatgpt', 'claude']);
    calls.length = 0;
    await api.runWithProviders('auto', async provider => { calls.push(provider); return true; });
    assert.deepEqual(calls, ['chatgpt']);
});

test('JSON extraction preserves long Unicode prose with unmatched braces and escaped quotes', () => {
    const { api } = harness();
    const answer = 'Длинный ответ } и код {; "quoted" \\ end\n'.repeat(1500);
    const payload = JSON.stringify({ answers: [{ q: 1, a: [answer] }] });
    const objects = api.extractJsonObjects('A stray closing brace }\n```json\n' + payload + '\n```');
    assert.equal(objects.length, 1);
    assert.equal(JSON.parse(objects[0]).answers[0].a[0], answer);
    assert.equal(api.extractJsonObjects(payload.slice(0, -1)).length, 0);
});

test('missing or duplicate question numbers do not count as a complete response', () => {
    const { api } = harness();
    assert.equal(api.hasCompleteAnswers([{ q: 1, a: ['A'] }, { q: 1, a: ['B'] }], 2), false);
    assert.equal(api.hasCompleteAnswers([{ q: 1, a: ['A'] }, { q: 2, a: [''] }], 2), false);
    assert.equal(api.hasCompleteAnswers([{ q: 1, a: ['A'] }, { q: 2, a: ['B'] }], 2), true);
});

test('a valid JSON fragment is not accepted while generation is still active', async () => {
    const h = harness();
    let processing = true, text = '{"answers":[{"q":1,"a":["draft"]}]}', result;
    const pending = h.api.waitForResponse(() => text, { timeoutMs: 600000, isProcessing: () => processing }).then(value => { result = value; });
    await h.advance(70000);
    assert.equal(result, undefined);
    text = JSON.stringify({ answers: [{ q: 1, a: ['Final answer '.repeat(2000)] }] });
    processing = false;
    await h.advance(5000);
    await pending;
    assert.equal(result, text);
    assert.equal(h.observers.size, 0);
    assert.equal(h.timers.size, 0);
});

test('waiting for the first response can exceed 60 seconds', async () => {
    const h = harness();
    let text = '', result;
    const pending = h.api.waitForResponse(() => text, { timeoutMs: 600000 }).then(value => { result = value; });
    await h.advance(120000);
    assert.equal(result, undefined);
    text = 'A late but complete answer';
    await h.advance(5000);
    await pending;
    assert.equal(result, text);
});

test('timeout rejects a partial stream and cleans up timers and observers', async () => {
    const h = harness({ document: { body: {} } });
    const pending = h.api.waitForResponse(() => 'unfinished answer', { timeoutMs: 600000, isProcessing: () => true });
    const rejection = assert.rejects(pending, /timed out/);
    await h.advance(600000);
    await rejection;
    assert.equal(h.observers.size, 0);
    assert.equal(h.timers.size, 0);
});

test('cancellation rejects without returning a partial answer', async () => {
    const h = harness();
    let cancelled = false;
    const pending = h.api.waitForResponse(() => 'unfinished', { isProcessing: () => true, isCancelled: () => cancelled });
    const rejection = assert.rejects(pending, /cancelled/);
    cancelled = true;
    await h.advance(800);
    await rejection;
});

for (const provider of ['chatgpt', 'claude']) {
  for (const scenario of ['streaming pause', 'incomplete JSON']) {
    test(`${provider} bridge saves the entire late response after a ${scenario}`, async () => {
        let processing = false, responseText = '';
        const responses = [];
        const input = { tagName: provider === 'chatgpt' ? 'TEXTAREA' : 'DIV', className: 'tiptap', id: 'prompt-textarea',
            innerText: '', value: '', focus() {}, dispatchEvent() {} };
        const document = {
            body: { appendChild() {} },
            createElement: () => ({ style: {}, remove() {} }),
            execCommand: (command, _, text) => { if (command === 'insertText') input.innerText = text; return true; },
            querySelectorAll: () => responses,
            querySelector: selector => {
                if (/Stop|stop-button|data-is-streaming/.test(selector)) return processing ? {} : null;
                if (/send-button|Send/.test(selector)) return send;
                return input;
            },
        };
        const h = harness({ document });
        const answer = 'Full answer } with "quotes" and markup <tag>\n'.repeat(1200);
        const complete = JSON.stringify({ answers: [{ q: 1, a: [answer] }] });
        const send = { disabled: false, click() {
            processing = true;
            h.context.setTimeout(() => {
                const draft = '{"answers":[{"q":1,"a":["draft"]}]}';
                responseText = scenario === 'incomplete JSON' ? draft.slice(0, -1) : draft;
                processing = scenario === 'streaming pause';
                responses.push({ get innerText() { return responseText; }, getAttribute: attr => attr === 'data-message-id' ? null : 'assistant' });
                h.notify();
            }, 70000);
            h.context.setTimeout(() => { responseText = complete; processing = false; h.notify(); }, 95000);
        } };
        const taskKey = provider === 'chatgpt' ? 'cqsChatGptTask' : 'cqsClaudeTask';
        const answerKey = provider === 'chatgpt' ? 'cqsChatGptAnswers' : 'cqsClaudeAnswers';
        h.local[taskKey] = { taskId: 'test-task', prompt: 'Test prompt', expectedAnswers: 1, deadline: 600000 };
        vm.runInContext(read(`${provider}_bridge.js`), h.context);
        await h.advance(90000);
        assert.equal(h.local[answerKey], undefined, 'must not publish a draft while streaming');
        await h.advance(30000);
        assert.equal(h.local[answerKey]?.rawText, complete);
        assert.equal(h.local[answerKey]?.answers[0].a[0], answer);
        assert.equal(h.local[answerKey]?.taskId, 'test-task');
        assert.equal(h.local[taskKey], undefined);
    });
  }
}

function contentHarness() {
    const messages = [], statuses = [];
    let submitted = 0;
    const h = harness({
        location: { href: 'https://www.coursera.org/learn/test/quiz/example' },
        document: { readyState: 'loading', addEventListener() {} },
    });
    h.context.chrome.runtime.onMessage.addListener = fn => messages.push(fn);
    h.context.testDeps = {
        clickStartButton: async () => true,
        waitFor: async () => true,
        delay: async () => {},
        solveWithSelectedProvider: async () => false,
        solveWithWebUI: async () => { throw new Error('unexpected forced provider'); },
        checkHonorCode: async () => { throw new Error('must not check honor pledge on failure'); },
        submitQuiz: async () => { submitted++; return true; },
        clearState: async () => {},
        setStatus: message => statuses.push(message),
    };
    const source = read('content.js');
    const index = source.lastIndexOf('})();');
    const hooks = `\nclickStartButton = testDeps.clickStartButton; waitFor = testDeps.waitFor; delay = testDeps.delay;
        solveWithSelectedProvider = testDeps.solveWithSelectedProvider; solveWithWebUI = testDeps.solveWithWebUI;
        checkHonorCode = testDeps.checkHonorCode; submitQuiz = testDeps.submitQuiz;
        clearState = testDeps.clearState; setStatus = testDeps.setStatus;
        globalThis.contentHooks = { autoSolveAndSubmit, autoSelect };\n`;
    vm.runInContext(source.slice(0, index) + hooks + source.slice(index), h.context);
    return { ...h, messages, statuses, submitted: () => submitted };
}

test('queue stops after provider failure, including quizzes previously marked forceClaude', async () => {
    const h = contentHarness();
    await h.context.contentHooks.autoSolveAndSubmit({ quizUrls: [{ url: 'test', forceClaude: true }], currentIndex: 0 });
    assert.equal(h.submitted(), 0);
    assert.match(h.statuses.at(-1), /No complete answer/);
});

test('single-page action does not submit after provider failure', async () => {
    const h = contentHarness();
    h.messages[0]({ type: 'TRIGGER_SOLVE_ALL' }, null, () => {});
    await flush();
    assert.equal(h.submitted(), 0);
    assert.match(h.statuses.at(-1), /No complete answer/);
});

test('long textarea answers are restored in full if insertText silently truncates them', () => {
    const h = contentHarness();
    class TextArea {
        constructor() { this._value = ''; }
        get value() { return this._value; }
        set value(value) { this._value = value; }
        getAttribute() { return null; }
        focus() {}
        select() {}
        dispatchEvent() {}
    }
    const input = new TextArea();
    const answer = 'Long multiline answer\n'.repeat(3000);
    h.context.HTMLTextAreaElement = TextArea;
    h.context.document.execCommand = () => { input.value = answer.slice(0, 5000); return true; };
    const block = { querySelector: selector => selector === 'textarea[aria-label="Enter answer here"]' ? input : null };
    h.context.contentHooks.autoSelect(block, { suggestedText: answer }, 'text');
    assert.equal(input.value, answer);
});

test('long rich-text answers are restored in full if insertText silently truncates them', () => {
    const h = contentHarness();
    const input = { innerText: '', textContent: '', focus() {}, dispatchEvent() {}, getAttribute: () => 'true' };
    const answer = 'Long rich text\n'.repeat(3000);
    h.context.document.execCommand = () => { input.innerText = answer.slice(0, 5000); return true; };
    const block = {
        querySelector: selector => selector === '[contenteditable="true"]' ? input : null,
        querySelectorAll: () => [],
    };
    h.context.contentHooks.autoSelect(block, { suggestedText: answer }, 'text');
    assert.equal(input.textContent, answer);
});
