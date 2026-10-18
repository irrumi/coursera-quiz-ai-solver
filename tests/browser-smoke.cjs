// Optional UI checks: requires Playwright and an installed Chromium browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'test-artifacts');

(async () => {
    const browser = await chromium.launch({ headless: true, ...(process.env.CQS_BROWSER_CHANNEL ? { channel: process.env.CQS_BROWSER_CHANNEL } : {}) });
    try {
        const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ version }) => {
            const changeListeners = [];
            const area = key => ({
                async get(keys, callback) {
                    const data = JSON.parse(localStorage.getItem(key) || '{}');
                    const result = Object.fromEntries(keys.map(name => [name, data[name]]));
                    callback?.(result);
                    return result;
                },
                async set(values, callback) {
                    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), ...values }));
                    const changes = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { newValue: value }]));
                    [...changeListeners].forEach(listener => listener(changes, key));
                    callback?.();
                },
                async remove(keys, callback) {
                    const data = JSON.parse(localStorage.getItem(key) || '{}');
                    keys.forEach(name => delete data[name]);
                    localStorage.setItem(key, JSON.stringify(data));
                    callback?.();
                },
            });
            window.sentMessages = [];
            window.runtimeMessages = [];
            window.injectedScripts = [];
            window.activeUrl = 'https://www.coursera.org/learn/test/quiz/example';
            window.chrome = {
                storage: { sync: area('sync'), local: area('local'), onChanged: {
                    addListener: fn => changeListeners.push(fn), removeListener: fn => { const index = changeListeners.indexOf(fn); if (index >= 0) changeListeners.splice(index, 1); },
                } },
                runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version }),
                    async sendMessage(message) {
                        window.runtimeMessages.push(message.type);
                        if (['OPEN_CHATGPT_TAB', 'OPEN_CLAUDE_TAB'].includes(message.type) && localStorage.getItem('fixtureMode') === 'flow') {
                            const key = message.type === 'OPEN_CHATGPT_TAB' ? 'cqsChatGptTask' : 'cqsClaudeTask';
                            const answerKey = message.type === 'OPEN_CHATGPT_TAB' ? 'cqsChatGptAnswers' : 'cqsClaudeAnswers';
                            const { [key]: task } = await chrome.storage.local.get([key]);
                            localStorage.setItem('fixtureExpected', String(task.expectedAnswers));
                            setTimeout(async () => {
                                const rawText = JSON.stringify({ answers: [{ q: 1, a: ['A'] }, { q: 2, a: ['Full flow answer\n'.repeat(4000)] }] });
                                await chrome.storage.local.set({ [answerKey]: { taskId: task.taskId, answers: [], rawText } });
                            }, 100);
                            return { ok: true };
                        }
                        if (message.type === 'CQS_DEBUG_EVENT') { await CqsDebug.record(message.entry); return { ok: true }; }
                        if (message.type === 'CQS_DEBUG_REPORT') return { ok: true, report: await CqsDebug.report() };
                        if (message.type === 'CQS_DEBUG_CLEAR') { await chrome.storage.local.remove(['cqsDebugLog']); return { ok: true }; }
                        return { ok: true };
                    },
                },
                tabs: {
                    async query(_, callback) { const tabs = [{ id: 1, url: window.activeUrl }]; callback?.(tabs); return tabs; },
                    async sendMessage(_, message, callback) {
                        const reply = message.type === 'CQS_CONTENT_PING' ? window.forceContentMissing ? null : { ok: true, version } : { ok: true };
                        if (message.type !== 'CQS_CONTENT_PING') window.sentMessages.push(message);
                        callback?.(reply); return reply;
                    },
                },
                scripting: { async executeScript(spec) { window.injectedScripts.push(...spec.files); window.forceContentMissing = false; } },
            };
        }, { version: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version });
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname !== 'extension.test') return route.abort();
            if (url.pathname === '/provider.html') {
                return route.fulfill({ contentType: 'text/html', body: `<html><body>
                  <textarea id="prompt-textarea" style="display:none"></textarea>
                  <div data-content-search-unit-key="old" data-chatgpt-search-message-ids="old"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div>Old response</div></div>
                  <form data-chatgpt-composer oninput="this.querySelector('button').disabled=false" onsubmit="event.preventDefault();window.providerSent=true;document.querySelector('[data-composer-markdown]').textContent='';const turn=document.createElement('div');turn.dataset.talvtTurnState='streaming';turn.innerHTML='<div data-content-search-unit-key=new data-chatgpt-search-message-ids=new><h4 data-conversation-role=assistant>ChatGPT said:</h4><div id=response></div></div>';document.body.appendChild(turn);document.querySelector('#response').textContent=JSON.stringify({answers:[{q:1,a:['draft']}]});setTimeout(()=>{document.querySelector('#response').textContent=JSON.stringify({answers:[{q:1,a:['Long final answer with &lt;literal&gt; markup and braces }\\n'.repeat(1500)]}]});turn.dataset.talvtTurnState='complete'},4200)">
                    <div class="ProseMirror" role="textbox" contenteditable="true" data-composer-markdown></div>
                    <button type="submit" aria-label="Отправить" disabled>Send</button>
                  </form><script src="/ai_common.js"></script><script src="/diagnostics.js"></script><script src="/chatgpt_bridge.js"></script>
                  </body></html>` });
            }
            if (url.pathname === '/idle.html') return route.fulfill({ contentType: 'text/html', body: '<html><body>Next quiz destination reached.</body></html>' });
            if (url.pathname === '/learn/test/quiz/flow') {
                return route.fulfill({ contentType: 'text/html', body: `<html><head></head><body><main>
                  <button data-testid="action-button" onclick="this.remove()">Start quiz</button>
                  <div data-testid="part-Submission_MultipleChoiceQuestion"><p>Which option should be selected?</p>
                    <label><input type="radio" name="choice" value="A">First answer</label><label><input type="radio" name="choice" value="B">Second answer</label></div>
                  <div data-testid="part-Submission_TextInputQuestion"><p>Explain the result in a written answer.</p>
                    <div data-testid="TextInputQuestion"><textarea aria-label="Enter answer here"></textarea></div></div>
                  <button data-testid="submit-button" onclick="localStorage.setItem('fixtureSubmission', JSON.stringify({clicks: Number(localStorage.getItem('fixtureClicks') || 0) + 1, radio: document.querySelector('input[value=A]').checked, textLength: document.querySelector('textarea').value.length}));localStorage.setItem('fixtureClicks', String(Number(localStorage.getItem('fixtureClicks') || 0) + 1));document.querySelector('#receipt').textContent='You passed!'">Submit quiz</button>
                  <div id="receipt"></div></main>
                  <script src="/ai_common.js"></script><script src="/diagnostics.js"></script><script src="/quiz_scan.js"></script><script src="/content.js"></script></body></html>` });
            }
            if (url.pathname === '/learn/test/quiz/example') {
                return route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><div id="question"><p>Original question</p><textarea aria-label="Enter answer here"></textarea></div><script src="/ai_common.js"></script><script src="/diagnostics.js"></script><script src="/quiz_scan.js"></script><script src="/content.js"></script></body></html>' });
            }
            const name = path.basename(url.pathname);
            const file = path.join(root, name);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
            let body = fs.readFileSync(file, 'utf8');
            if (name === 'content.js') {
                const index = body.lastIndexOf('})();');
                body = body.slice(0, index) + 'globalThis.cqsTestHooks = { showAnswer, findBlocks };\n' + body.slice(index);
            }
            return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body });
        });

        await page.goto('https://extension.test/popup.html');
        await page.getByRole('button', { name: 'Claude', exact: true }).click();
        await page.locator('#response-timeout').selectOption('1200');
        await page.getByRole('button', { name: 'Solve Current Page' }).click();
        assert.equal(await page.evaluate(() => window.sentMessages[0]?.type), 'TRIGGER_SOLVE_ALL');
        assert.equal(await page.evaluate(async () => (await CqsAI.getSettings()).provider), 'claude');
        await page.reload();
        await page.waitForFunction(() => document.querySelector('[data-provider="claude"]').getAttribute('aria-pressed') === 'true');
        assert.equal(await page.locator('#response-timeout').inputValue(), '1200');
        await page.getByRole('button', { name: 'Auto', exact: true }).click();
        assert.match(await page.locator('#provider-help').textContent(), /then Claude/);

        await page.goto('https://extension.test/options.html');
        await page.waitForFunction(() => document.querySelector('#opt-provider').value === 'auto');
        await page.locator('#opt-provider').selectOption('chatgpt');
        await page.locator('#opt-response-timeout').selectOption('600');
        await page.getByRole('button', { name: 'Save Settings' }).click();
        await page.waitForFunction(() => document.querySelector('#saved-msg').classList.contains('show'));
        await page.goto('https://extension.test/popup.html');
        await page.waitForFunction(() => !document.querySelector('[data-provider="chatgpt"]').disabled);
        assert.equal(await page.locator('[data-provider="chatgpt"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#response-timeout').inputValue(), '600');
        await page.evaluate(() => { window.forceContentMissing = true; });
        await page.getByRole('button', { name: 'Auto-Solve Quizzes', exact: true }).click();
        await page.waitForFunction(() => window.sentMessages.at(-1)?.phase === 'collect_quizzes');
        assert.ok(await page.evaluate(() => window.injectedScripts.includes('content.js')));
        await page.getByRole('button', { name: 'Scan quizzes', exact: true }).click();
        await page.waitForFunction(() => window.sentMessages.at(-1)?.phase === 'scan_quizzes');
        await page.getByRole('button', { name: 'Debug', exact: true }).click();
        await page.waitForFunction(() => window.runtimeMessages.includes('OPEN_DEBUG'));
        fs.mkdirSync(artifacts, { recursive: true });
        await page.locator('.container').screenshot({ path: path.join(artifacts, 'popup.png') });

        await page.goto('https://extension.test/learn/test/quiz/example');
        await page.locator('#cqs-toolbar').waitFor();
        assert.equal(await page.locator('#cqs-provider').inputValue(), 'chatgpt');
        await page.locator('#cqs-provider').selectOption('claude');
        await page.locator('#cqs-response-timeout').selectOption('1800');
        await page.waitForFunction(async () => (await CqsAI.getSettings()).responseTimeoutSeconds === 1800);
        assert.equal(await page.evaluate(async () => (await CqsAI.getSettings()).provider), 'claude');
        const answer = 'Длинный ответ с "кавычками", } и <b>plain text</b>\n'.repeat(1300);
        await page.evaluate(text => {
            cqsTestHooks.showAnswer(document.querySelector('#question'), { suggestedText: text, reasoning: text, answers: [], confidence: 88 }, [], 'text', 'ChatGPT');
        }, answer);
        assert.equal(await page.locator('textarea').inputValue(), answer);
        assert.equal(await page.locator('.cqs-suggested-text').textContent(), answer);
        assert.equal(await page.locator('.cqs-suggested-text b').count(), 0, 'answer markup must remain literal text');
        await page.getByRole('button', { name: 'Copy answer', exact: true }).click();
        await page.getByRole('button', { name: 'Copied!', exact: true }).waitFor();
        // Windows clipboard text uses CRLF; the content must otherwise match exactly.
        const clipboard = await page.evaluate(() => navigator.clipboard.readText());
        assert.equal(clipboard.replace(/\r\n/g, '\n'), answer);
        await page.locator('#cqs-toolbar').screenshot({ path: path.join(artifacts, 'toolbar.png') });

        const scan = await page.evaluate(async () => {
            const host = document.createElement('section');
            host.innerHTML = `<table>
              <tr><td><a href="https://www.coursera.org/learn/test/quiz/done/quiz-a">Quiz A</a></td><td>Passed — 90%</td></tr>
              <tr><td><a href="https://www.coursera.org/learn/test/quiz/todo/quiz-b">Quiz B</a></td><td>Not completed</td></tr>
              <tr><td><a href="https://www.coursera.org/learn/test/exam/failed/quiz-c">Quiz C</a></td><td>Didn't pass — 50%</td></tr>
              <tr><td><a aria-disabled="true" href="https://www.coursera.org/learn/test/quiz/locked/quiz-d">Quiz D</a></td><td>Locked</td></tr>
              <tr><td><a href="https://www.coursera.org/learn/test/assignment-submission/wait/quiz-e">Quiz E</a></td><td>Submitted, grading pending</td></tr>
              <tr><td><a href="https://www.coursera.org/learn/test/quiz/unknown/quiz-f">How to pass a quiz</a></td><td><span style="display:none">Passed</span>No grade</td></tr>
              <tr style="display:none"><td><a href="https://www.coursera.org/learn/test/quiz/hidden/quiz-hidden">Hidden Quiz</a></td><td>Passed</td></tr>
            </table>
            <div><div><a href="https://www.coursera.org/learn/test/quiz/isolated/quiz-g">Quiz G</a></div>
              <div><a href="https://www.coursera.org/learn/test/lecture/video/completed-video">Video</a><span>Completed</span></div></div>`;
            document.body.appendChild(host);
            const result = CqsQuizzes.scan();
            await chrome.storage.local.set({ cqsQuizScan: result });
            const nested = document.createElement('div');
            nested.dataset.testid = 'part-Submission_TextInputQuestion';
            nested.innerHTML = '<p>Question text</p><div data-testid="TextInputQuestion"><textarea aria-label="Enter answer here"></textarea></div>';
            document.body.appendChild(nested);
            window.detectedQuestions = cqsTestHooks.findBlocks().length;
            return result;
        });
        assert.equal(scan.counts.total, 7);
        assert.equal(scan.counts.completed, 1);
        assert.equal(scan.counts.pending, 1);
        assert.equal(scan.counts.failed, 1);
        assert.equal(scan.counts.waiting, 1);
        assert.equal(scan.counts.locked, 1);
        assert.equal(scan.counts.unknown, 2);
        assert.equal(scan.items.filter(item => item.queued).length, 4);
        assert.equal(await page.evaluate(() => window.detectedQuestions), 2, 'one original text box and one nested question must be counted once each');

        await page.goto('https://extension.test/diagnostics.html');
        await page.waitForFunction(() => document.querySelector('#scan-items').children.length === 7);
        assert.match(await page.locator('#scan-summary').textContent(), /7 quizzes/);
        await page.getByRole('button', { name: 'Copy report', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#status').textContent === 'Report copied.');
        const report = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(report, /"completed": 1/);
        assert.doesNotMatch(report, /Quiz A|coursera\.org|Long multiline|Длинный ответ/);
        await page.screenshot({ path: path.join(artifacts, 'debug.png') });

        await page.evaluate(async () => {
            localStorage.setItem('fixtureMode', 'flow');
            await chrome.storage.sync.set({ settings: { provider: 'chatgpt', responseTimeoutSeconds: 600 } });
            await chrome.storage.local.set({ cqsAutoState: { active: true, phase: 'quiz', courseSlug: 'test', currentIndex: 0,
                quizUrls: ['https://extension.test/learn/test/quiz/flow', 'https://extension.test/idle.html'] } });
        });
        await page.goto('https://extension.test/learn/test/quiz/flow');
        await page.waitForURL('https://extension.test/idle.html', { timeout: 45000 });
        const flow = await page.evaluate(async () => ({
            data: await chrome.storage.local.get(['cqsAutoState', 'cqsLastQueue']),
            expected: Number(localStorage.getItem('fixtureExpected')),
            submission: JSON.parse(localStorage.getItem('fixtureSubmission') || 'null'),
        }));
        assert.equal(flow.expected, 2, 'the nested text editor must not add a phantom question');
        assert.equal(flow.submission?.radio, true);
        assert.equal(flow.submission?.textLength, 'Full flow answer\n'.repeat(4000).length);
        assert.equal(flow.submission?.clicks, 1, 'submission must only be clicked once');
        assert.equal(flow.data.cqsAutoState.currentIndex, 1);
        assert.equal(flow.data.cqsLastQueue.results[0].status, 'completed');

        // Reproduce the observed GPT layout: no prompt id, role on a heading,
        // Russian Send label and a complete-looking draft while still streaming.
        await page.evaluate(() => localStorage.clear());
        await page.goto('https://extension.test/provider.html');
        assert.equal(await page.evaluate(() => CqsAI.findChatGptEditor()?.getAttribute('data-composer-markdown')), '');
        await page.evaluate(async () => {
            await chrome.storage.local.set({ cqsChatGptTask: { taskId: 'new-layout', prompt: 'A literal <script> marker and a question', expectedAnswers: 1, deadline: Date.now() + 30000 } });
        });
        const providerHandle = await page.waitForFunction(() => {
            const data = JSON.parse(localStorage.getItem('local') || '{}').cqsChatGptAnswers;
            return data?.taskId === 'new-layout' ? data : false;
        }, null, { timeout: 25000 });
        const providerResult = await providerHandle.jsonValue();
        assert.equal(providerResult.error, undefined);
        assert.equal(providerResult.answers[0].a[0], 'Long final answer with <literal> markup and braces }\n'.repeat(1500));
        assert.equal(await page.evaluate(() => window.providerSent), true);
        assert.deepEqual(errors, []);
        console.log('Browser smoke passed: provider settings, quiz scan/queue, Debug export, long answers, full ChatGPT bridge with observed composer/response markup and streaming guard (synthetic fixtures).');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
