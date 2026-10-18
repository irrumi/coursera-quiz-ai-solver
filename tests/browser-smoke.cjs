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
        await page.addInitScript(() => {
            const area = key => ({
                async get(keys, callback) {
                    const data = JSON.parse(localStorage.getItem(key) || '{}');
                    const result = Object.fromEntries(keys.map(name => [name, data[name]]));
                    callback?.(result);
                    return result;
                },
                async set(values, callback) {
                    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), ...values }));
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
            window.chrome = {
                storage: { sync: area('sync'), local: area('local'), onChanged: { addListener() {} } },
                runtime: { onMessage: { addListener() {} } },
                tabs: {
                    query: (_, callback) => callback([{ id: 1 }]),
                    sendMessage: (_, message, callback) => { window.sentMessages.push(message); callback({ ok: true }); },
                },
            };
        });
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname !== 'extension.test') return route.abort();
            if (url.pathname === '/learn/test/quiz/example') {
                return route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><div id="question"><textarea aria-label="Enter answer here"></textarea></div><script src="/ai_common.js"></script><script src="/content.js"></script></body></html>' });
            }
            const name = path.basename(url.pathname);
            const file = path.join(root, name);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
            let body = fs.readFileSync(file, 'utf8');
            if (name === 'content.js') {
                const index = body.lastIndexOf('})();');
                body = body.slice(0, index) + 'globalThis.cqsTestHooks = { showAnswer };\n' + body.slice(index);
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
        assert.deepEqual(errors, []);
        console.log('Browser smoke passed: provider buttons, persisted settings, toolbar, full 62k+ answer insertion/display/clipboard.');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
