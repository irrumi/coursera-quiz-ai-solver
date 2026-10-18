const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const project = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(project, name), 'utf8');
const extensionVersion = JSON.parse(read('manifest.json')).version;
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
            [...listeners].forEach(listener => listener(changes, namespace));
            callback?.();
        },
        async remove(keys, callback) {
            const changes = {};
            for (const key of keys) {
                changes[key] = { oldValue: data[key] };
                delete data[key];
            }
            [...listeners].forEach(listener => listener(changes, namespace));
            callback?.();
        },
    });
    class FakeDate extends Date { static now() { return now; } }
    class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
    const context = vm.createContext({
        Date: FakeDate, URL,
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
            storage: { local: storage(local, 'local'), sync: storage(sync, 'sync'), onChanged: {
                addListener: fn => listeners.push(fn), removeListener: fn => { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); },
            } },
            runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: extensionVersion }),
                sendMessage: async () => ({ ok: true }) },
        },
        ...extra,
    });
    vm.runInContext(read('ai_common.js'), context);
    vm.runInContext(read('quiz_scan.js'), context);
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
        const input = { tagName: 'DIV', className: 'ProseMirror', id: 'prompt-textarea',
            innerText: '', value: '', focus() {}, dispatchEvent() {}, getAttribute: () => null, closest: selector => selector === 'form' ? document : null };
        const document = {
            body: { appendChild() {} },
            createElement: () => ({ style: {}, remove() {} }),
            execCommand: (command, _, text) => { if (command === 'insertText') input.innerText = text; return true; },
            querySelectorAll: selector => selector === 'button' ? [send]
                : provider === 'chatgpt' && /prompt-textarea|data-composer-markdown/.test(selector) ? [input]
                : selector === '[data-conversation-role="assistant"]' ? []
                : selector.startsWith('button[')
                ? processing ? [{ getAttribute: name => name === 'data-testid' ? 'stop-button' : name === 'aria-label' ? 'Stop generating' : null }] : []
                : responses,
            querySelector: selector => {
                if (/Stop|stop-button|data-is-streaming/.test(selector)) return processing ? {} : null;
                if (/send-button|Send/.test(selector)) return send;
                return input;
            },
        };
        const h = harness({ document });
        const answer = 'Full answer } with "quotes" and markup <tag>\n'.repeat(1200);
        const complete = JSON.stringify({ answers: [{ q: 1, a: [answer] }] });
        const send = { disabled: false, getAttribute: key => key === 'data-testid' ? 'send-button' : null, click() {
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
        assert.ok(h.local[answerKey]?.rawText === complete, 'full raw response must be preserved');
        assert.ok(h.local[answerKey]?.answers[0].a[0] === answer, 'full parsed answer must be preserved');
        assert.equal(h.local[answerKey]?.taskId, 'test-task');
        assert.equal(h.local[taskKey], undefined);
    });
  }
}

function contentHarness(overrides = {}) {
    const messages = [], statuses = [];
    let submitted = 0, pledged = 0;
    const h = harness({
        location: { href: 'https://www.coursera.org/learn/test/quiz/example' },
        document: { readyState: 'loading', addEventListener() {}, querySelector: () => null, body: { innerText: '' } },
    });
    h.context.chrome.runtime.onMessage.addListener = fn => messages.push(fn);
    h.context.testDeps = {
        clickStartButton: async () => true,
        waitFor: async fn => fn(),
        findBlocks: () => [],
        delay: async () => {},
        solveWithSelectedProvider: async () => false,
        solveWithWebUI: async () => { throw new Error('unexpected forced provider'); },
        checkHonorCode: async () => { pledged++; },
        submitQuiz: async () => { submitted++; return true; },
        clearState: async () => {},
        setStatus: message => statuses.push(message),
        ...overrides,
    };
    const source = read('content.js');
    const index = source.lastIndexOf('})();');
    const hooks = `\nclickStartButton = testDeps.clickStartButton; waitFor = testDeps.waitFor; delay = testDeps.delay;
        solveWithSelectedProvider = testDeps.solveWithSelectedProvider; solveWithWebUI = testDeps.solveWithWebUI;
        checkHonorCode = testDeps.checkHonorCode; submitQuiz = testDeps.submitQuiz;
        clearState = testDeps.clearState; setStatus = testDeps.setStatus;
        findBlocks = testDeps.findBlocks;
        globalThis.contentHooks = { autoSolveAndSubmit, autoSelect, reconcileSubmission, advanceQuiz, collectQuizzes, startPipeline, invalidAnswerQuestions, requestStop: () => { stopRequested = true; } };\n`;
    vm.runInContext(source.slice(0, index) + hooks + source.slice(index), h.context);
    return { ...h, messages, statuses, submitted: () => submitted, pledged: () => pledged };
}

test('queue stops after provider failure, including quizzes previously marked forceClaude', async () => {
    const h = contentHarness();
    await h.context.contentHooks.autoSolveAndSubmit({ quizUrls: [{ url: 'test', forceClaude: true }], currentIndex: 0 });
    assert.equal(h.submitted(), 0);
    assert.equal(h.pledged(), 0);
    assert.equal(h.local.cqsAutoState.active, false);
    assert.equal(h.local.cqsAutoState.lastError, 'AI_RESPONSE_FAILED');
});

test('single-page action does not submit after provider failure', async () => {
    const h = contentHarness();
    h.messages[0]({ type: 'TRIGGER_SOLVE_ALL' }, null, () => {});
    await flush();
    assert.equal(h.submitted(), 0);
    assert.equal(h.pledged(), 0);
});

test('Stop during answer capture prevents pledge and submission', async () => {
    let h;
    h = contentHarness({ solveWithSelectedProvider: async () => { h.context.contentHooks.requestStop(); return true; } });
    await h.context.contentHooks.autoSolveAndSubmit({ quizUrls: ['test'], currentIndex: 0 });
    assert.equal(h.pledged(), 0);
    assert.equal(h.submitted(), 0);
});

test('Stop during the delay before Submit prevents submission', async () => {
    let h;
    h = contentHarness({ solveWithSelectedProvider: async () => true,
        delay: async ms => { if (ms === 600) h.context.contentHooks.requestStop(); } });
    await h.context.contentHooks.autoSolveAndSubmit({ quizUrls: ['test'], currentIndex: 0 });
    assert.equal(h.submitted(), 0);
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

test('a React response updated in place is detected with the same node and message id', () => {
    const { api } = harness();
    const node = { innerText: 'Previous answer', getAttribute: () => 'same-message-id' };
    const readResponse = api.createResponseTracker(() => [node]);
    assert.equal(readResponse(), '');
    node.innerText = '{"answers":[{"q":1,"a":["B"]}]}';
    assert.equal(readResponse(), node.innerText);
});

test('a remounted old response without an id is not accepted as a new answer', () => {
    const { api } = harness();
    let nodes = [{ innerText: 'Old response', getAttribute: () => null }];
    const readResponse = api.createResponseTracker(() => nodes);
    nodes = [{ innerText: 'Old response', getAttribute: () => null }];
    assert.equal(readResponse(), '');
    nodes[0].innerText = 'A new completed response';
    assert.equal(readResponse(), 'A new completed response');
});

test('hidden and disabled Stop buttons do not block response capture', () => {
    const stop = { hidden: true, getAttribute: key => key === 'aria-label' ? 'Stop generating' : null };
    const h = harness({ document: { querySelectorAll: () => [stop] } });
    assert.equal(h.api.isProviderProcessing('chatgpt', 'A final answer'), false);
    stop.hidden = false; stop.disabled = true;
    assert.equal(h.api.isProviderProcessing('chatgpt', 'A final answer'), false);
    stop.disabled = false;
    assert.equal(h.api.isProviderProcessing('chatgpt', 'A final answer'), true);
});

test('numeric and scalar text answers are normalized without losing long text', () => {
    const { api } = harness();
    const normalized = api.normalizeAnswers([{ q: '1', a: 0 }, { q: 2, text: 'Long text\n'.repeat(2000) }]);
    assert.equal(normalized[0].a[0], '0');
    assert.equal(normalized[1].a[0].length, 20000);
    assert.equal(api.hasCompleteAnswers(normalized, 2), true);
});

test('ChatGPT editor discovery waits beyond sixty seconds and cancels without sending', async () => {
    const h = harness({ document: { readyState: 'complete', querySelectorAll: () => [] } });
    h.local.cqsChatGptTask = { taskId: 'late-editor', prompt: 'Test prompt', deadline: 300000 };
    vm.runInContext(read('chatgpt_bridge.js'), h.context);
    await h.advance(70000);
    assert.equal(h.local.cqsChatGptAnswers, undefined);
    assert.equal(h.local.cqsChatGptProgress.stage, 'finding_editor');
    await h.context.chrome.storage.local.remove(['cqsChatGptTask']);
    await h.advance(1000);
    assert.equal(h.local.cqsChatGptAnswers, undefined);
    assert.equal(h.timers.size, 0);
});

test('repeated page layout warnings cannot flood out useful debug events', () => {
    const handlers = {}, events = [];
    const h = harness({ addEventListener: (name, handler) => { handlers[name] = handler; } });
    h.context.chrome.runtime.sendMessage = message => { events.push(message.entry); return Promise.resolve({ ok: true }); };
    vm.runInContext(read('diagnostics.js'), h.context);
    h.context.CqsDebug.attach('chatgpt');
    for (let i = 0; i < 300; i++) handlers.error({ message: 'ResizeObserver loop completed with undelivered notifications.' });
    handlers.error({ message: 'Actual bridge failure' });
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'page_layout_warning');
    assert.equal(events[0].level, 'warn');
    assert.equal(events[1].event, 'script_error');
    assert.equal(events[1].level, 'error');
});

test('a complete response envelope is accepted even if a question is missing', () => {
    const { api } = harness();
    assert.equal(api.hasCompleteResponseEnvelope('{"answers":[{"q":1,"a":["A"]}]}'), true);
    assert.equal(api.hasCompleteResponseEnvelope('{"answers":[{"q":1,"a":["A"]}]'), false);
});

test('storage events deliver the answer immediately, ignoring stale task ids', async () => {
    const h = harness();
    let result;
    const pending = h.api.waitForStoredAnswer({ answerKey: 'answer', progressKey: 'progress', taskId: 'current', timeoutMs: 600000 }).then(value => { result = value; });
    await h.context.chrome.storage.local.set({ answer: { taskId: 'old', answers: [] } });
    await flush();
    assert.equal(result, undefined);
    await h.context.chrome.storage.local.set({ answer: { taskId: 'current', answers: [{ q: 1, a: ['A'] }] } });
    await pending;
    assert.equal(result.taskId, 'current');
    assert.equal(h.timers.size, 0);
});

for (const [text, expected] of [
    ['Passed — Grade: 92%', 'completed'], ['Completed', 'completed'], ["Didn't pass — 60%", 'failed'],
    ['Not passed', 'failed'], ['Not completed', 'pending'], ['Incomplete', 'pending'], ['Not started', 'pending'],
    ['In progress — Resume', 'pending'], ['Not submitted', 'pending'], ['Submitted — grading pending', 'waiting'],
    ['Locked until next week', 'locked'], ['No grade is displayed', 'unknown'],
    ['2/5 completed', 'pending'], ['50% completed', 'pending'], ['Complete this quiz', 'unknown'], ['Complete', 'completed'],
]) {
    test(`quiz scan classifies ${JSON.stringify(text)} as ${expected}`, () => {
        const h = harness();
        const status = h.context.CqsQuizzes.classifyText(text);
        assert.equal(status.status, expected);
        assert.equal(status.queued, ['pending', 'failed', 'unknown'].includes(expected));
    });
}

test('diagnostics keep bounded technical logs and omit prompts, answers, screenshots and URLs', async () => {
    const h = harness();
    vm.runInContext(read('diagnostics.js'), h.context);
    for (let index = 0; index < 260; index++) {
        await h.context.CqsDebug.record({ source: 'test', event: 'response', details: {
            index, characters: 62000, prompt: 'PRIVATE PROMPT', rawText: 'PRIVATE ANSWER', screenshots: 'PRIVATE IMAGE',
            message: 'Could not read https://chatgpt.com/c/private-conversation',
        } });
    }
    const report = await h.context.CqsDebug.report();
    const json = JSON.stringify(report);
    assert.equal(report.events.length, 250);
    assert.equal(report.events[0].details.index, 10);
    assert.doesNotMatch(json, /PRIVATE|private-conversation|https:\/\//);
    assert.match(json, /62000/);
});

test('background targets one AI tab and reconnects an already-open tab missing the bridge', async () => {
    const h = harness();
    let injected = false;
    const files = [];
    h.context.chrome.tabs = {
        query: async () => [{ id: 1, windowId: 7 }, { id: 2, windowId: 7, active: true }],
        update: async () => {}, get: async () => ({ status: 'complete' }),
        sendMessage: async () => { if (!injected) throw new Error('Receiving end does not exist'); return { ok: true, version: extensionVersion }; },
    };
    h.context.chrome.windows = { update: async () => {} };
    h.context.chrome.scripting = { executeScript: async spec => { injected = true; files.push(...spec.files); } };
    vm.runInContext(read('diagnostics.js'), h.context);
    vm.runInContext(read('background.js').replace(/^import[^\n]+\n/, ''), h.context);
    h.local.cqsChatGptTask = { taskId: 'current', prompt: 'Do not log this' };
    const result = await h.context.handleMessage({ type: 'OPEN_CHATGPT_TAB', taskId: 'current' }, {});
    assert.equal(result.tabId, 2);
    assert.equal(h.local.cqsChatGptTask.targetTabId, 2);
    assert.ok(files.includes('chatgpt_bridge.js'));
    assert.equal((await h.context.handleMessage({ type: 'CQS_CLAIM_TASK', provider: 'chatgpt', taskId: 'current' }, { tab: { id: 1 } })).ok, false);
    assert.equal((await h.context.handleMessage({ type: 'CQS_CLAIM_TASK', provider: 'chatgpt', taskId: 'current' }, { tab: { id: 2 } })).ok, true);
});

test('the default pipeline scans quizzes rather than peer reviews', async () => {
    const h = contentHarness();
    await h.context.contentHooks.startPipeline();
    assert.equal(h.local.cqsAutoState.phase, 'collect_quizzes');
    assert.equal(h.context.location.href, 'https://www.coursera.org/learn/test/home/assignments');
});

test('quiz collection queues unfinished and failed items while skipping completed, locked and submitted items', async () => {
    const h = contentHarness();
    h.context.CqsQuizzes = { scan: () => ({ timestamp: 1, counts: { total: 5, completed: 1, pending: 1, failed: 1, waiting: 1, locked: 1, unknown: 0 },
        items: [{ url: 'done', status: 'completed', queued: false }, { url: 'todo', status: 'pending', queued: true },
            { url: 'failed', status: 'failed', queued: true }, { url: 'waiting', status: 'waiting', queued: false }, { url: 'locked', status: 'locked', queued: false }] }) };
    await h.context.contentHooks.collectQuizzes({ phase: 'collect_quizzes', courseSlug: 'test', active: true });
    assert.equal(h.local.cqsAutoState.quizUrls.length, 2);
    assert.equal(h.local.cqsAutoState.quizUrls[0].url, 'todo');
    assert.equal(h.local.cqsAutoState.quizUrls[1].url, 'failed');
    assert.equal(h.local.cqsQuizScan.counts.completed, 1);
    assert.equal(h.context.location.href, 'todo');
});

test('an empty scan reports no links rather than claiming all quizzes are complete', async () => {
    const h = contentHarness();
    h.context.CqsQuizzes = { scan: () => ({ counts: { total: 0 }, items: [] }) };
    await h.context.contentHooks.collectQuizzes({ phase: 'collect_quizzes', courseSlug: 'test' });
    assert.match(h.statuses.at(-1), /No quiz links found/);
    assert.equal(h.local.cqsAutoState, undefined);
});

test('an unconfirmed submission pauses on the current quiz without advancing or submitting again', async () => {
    const h = contentHarness();
    const original = h.context.location.href;
    await h.context.contentHooks.reconcileSubmission({ active: true, phase: 'awaiting_submission', currentIndex: 0, quizUrls: ['first', 'second'] });
    assert.equal(h.local.cqsAutoState.active, false);
    assert.equal(h.local.cqsAutoState.currentIndex, 0);
    assert.equal(h.local.cqsAutoState.lastError, 'SUBMISSION_UNCONFIRMED');
    assert.equal(h.context.location.href, original);
    assert.equal(h.submitted(), 0);
});

test('an already-passed quiz advances without sending another AI request or submission', async () => {
    const h = contentHarness();
    h.context.CqsQuizzes = { pageStatus: () => 'completed' };
    await h.context.contentHooks.autoSolveAndSubmit({ active: true, phase: 'quiz', courseSlug: 'test', currentIndex: 0, quizUrls: ['first', 'second'] });
    assert.equal(h.context.location.href, 'second');
    assert.equal(h.local.cqsAutoState.currentIndex, 1);
    assert.equal(h.local.cqsAutoState.results[0].status, 'completed');
    assert.equal(h.submitted(), 0);
    assert.equal(h.pledged(), 0);
});

test('invalid AI choice values cannot silently become option A', () => {
    const h = contentHarness();
    const meta = [{ type: 'radio', opts: ['First', 'Second'] }, { type: 'text', opts: [] }];
    assert.equal(h.context.contentHooks.invalidAnswerQuestions(meta, [{ q: 1, a: ['Z'] }, { q: 2, a: ['Long text'] }])[0], 1);
    assert.equal(h.context.contentHooks.invalidAnswerQuestions(meta, [{ q: 1, a: ['A', 'B'] }])[0], 1);
    assert.equal(h.context.contentHooks.invalidAnswerQuestions(meta, [{ q: 1, a: ['A'] }, { q: 2, a: ['Long text'] }]).length, 0);
});

test('an already-submitted quiz advances without re-submitting while waiting for a grade', async () => {
    const h = contentHarness();
    h.context.CqsQuizzes = { pageStatus: () => 'submitted' };
    await h.context.contentHooks.autoSolveAndSubmit({ active: true, phase: 'quiz', courseSlug: 'test', currentIndex: 0, quizUrls: ['first', 'second'] });
    assert.equal(h.local.cqsAutoState.currentIndex, 1);
    assert.equal(h.local.cqsAutoState.results[0].status, 'submitted');
    assert.equal(h.submitted(), 0);
});

test('a passed phrase inside question text does not mark the quiz as completed', () => {
    const question = 'If you passed an earlier test, what is the next step?';
    const source = { innerText: question + '\nStart quiz', querySelectorAll: () => [{ innerText: question }] };
    const h = harness({ document: { querySelector: () => source } });
    assert.equal(h.context.CqsQuizzes.pageStatus(), 'unknown');
    source.innerText = question + '\nYou passed!';
    assert.equal(h.context.CqsQuizzes.pageStatus(), 'completed');
});
