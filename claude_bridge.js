// claude_bridge.js — runs on claude.ai/* (Chrome extension content script)
// Lives tested selectors (Feb 2026):
//   Input:    div.tiptap.ProseMirror
//   Inject:   execCommand('insertText')  ← confirmed ✓
//   Send:     button[aria-label="Send message"]  ← confirmed ✓
//   Response: .font-claude-response  /  .font-claude-response-body  ← confirmed ✓

(async function () {
    'use strict';
    const bridgeVersion = chrome.runtime.getManifest().version;
    if (globalThis.__cqsClaudeBridgeVersion === bridgeVersion) return;
    globalThis.__cqsClaudeBridgeVersion = bridgeVersion;

    const TASK_KEY = 'cqsClaudeTask';
    const ANSWER_KEY = 'cqsClaudeAnswers';
    const PROGRESS_KEY = 'cqsClaudeProgress';
    let activeTaskId = null;
    globalThis.CqsDebug?.attach('claude');
    chrome.runtime.onMessage.addListener((message, _, reply) => {
        if (message.type === 'CQS_BRIDGE_PING') reply({ ok: true, provider: 'claude', version: bridgeVersion });
    });
    function launchTask(task) {
        handleTask(task).catch(async error => {
            if (activeTaskId !== task.taskId) return;
            globalThis.CqsDebug?.log('claude', 'task_failed', { taskId: task.taskId, message: error.message }, 'error');
            await chrome.storage.local.set({ [ANSWER_KEY]: { error: error.message, code: 'BRIDGE_ERROR', taskId: task.taskId } });
            await chrome.storage.local.remove([TASK_KEY]);
        });
    }

    // ── Listen for new tasks when the tab is reused ───────────────────────────
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes[TASK_KEY]) {
            if (changes[TASK_KEY].newValue) launchTask(changes[TASK_KEY].newValue);
            else activeTaskId = null;
        }
    });

    // ── Check for a pending task on initial load ──────────────────────────────
    const storage = await chrome.storage.local.get([TASK_KEY]);
    if (storage[TASK_KEY] && !activeTaskId) {
        launchTask(storage[TASK_KEY]);
    }

    async function handleTask(task) {
        if (!task?.prompt || activeTaskId === task.taskId) return;
        const claim = await chrome.runtime.sendMessage({ type: 'CQS_CLAIM_TASK', provider: 'claude', taskId: task.taskId });
        if (!claim?.ok || activeTaskId === task.taskId) return;
        activeTaskId = task.taskId;
        let lastProgressStage = '';
        const deadline = task.deadline || Date.now() + CqsAI.DEFAULT_SETTINGS.responseTimeoutSeconds * 1000;
        await updateProgress('finding_editor');

        console.log('[QuizAI Bridge] ✅ Task found. Prompt length:', task.prompt.length);

        // ── 2. Wait for the Tiptap editor to be fully hydrated ───────────────────────
        await delay(2500); // Claude's React/Tiptap takes 1-3s to mount

        const inputEl = await waitForEl([
            'div.tiptap.ProseMirror',              // Primary — live tested ✓
            'div[contenteditable="true"][enterkeyhint]',
            'div[contenteditable="true"][data-placeholder]',
            'div[contenteditable="true"]',         // Generic fallback
        ], 20000);

        if (!inputEl) {
            await storeError('Claude chat input not found. Make sure you are logged into claude.ai');
            return;
        }

        console.log('[QuizAI Bridge] Input found:', inputEl.className.slice(0, 80));

        // ── 3. Snapshot baseline BEFORE sending ──────────────────────────────────────
        // This tells us how many response elements exist BEFORE we send our message.
        // We'll only read elements that appear AFTER this count.
        const RESPONSE_SELS = [
            '.font-claude-response',
            '.font-claude-response-body',
            '[class*="font-claude-response"]',
        ];

        function getAllResponseEls() {
            for (const sel of RESPONSE_SELS) {
                const all = document.querySelectorAll(sel);
                const visible = [...all].filter(CqsAI.isVisible);
                if (visible.length > 0) return visible;
            }
            return [];
        }

        const readResponse = CqsAI.createResponseTracker(getAllResponseEls);
        await updateProgress('inserting_prompt');

        // ── 4. Paste question screenshots (for vision/image questions) ────────────
        if (Array.isArray(task.screenshots) && task.screenshots.length > 0) {
            console.log(`[QuizAI Bridge] Pasting ${task.screenshots.length} screenshot(s) for vision questions...`);
            await pasteImages(inputEl, task.screenshots);
            await delay(1500); // wait for Claude to process attachments
        }

        // ── 5. Inject the prompt ─────────────────────────────────────────────────────
        inputEl.focus();
        await delay(300);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await delay(150);

        // PRIMARY: execCommand insertText (confirmed working with Tiptap ✓)
        const inserted = document.execCommand('insertText', false, task.prompt);
        console.log('[QuizAI Bridge] insertText ok:', inserted, '| snippet:', (inputEl.innerText || '').slice(0, 60));

        // FALLBACK 1: ClipboardEvent
        if (!inserted || !(inputEl.innerText || '').trim()) {
            console.warn('[QuizAI Bridge] Falling back to ClipboardEvent...');
            const dt = new DataTransfer();
            dt.setData('text/plain', task.prompt);
            inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            await delay(400);
        }

        // FALLBACK 2: innerHTML injection
        if (!(inputEl.innerText || '').trim()) {
            console.warn('[QuizAI Bridge] Falling back to innerHTML...');
            inputEl.innerHTML = '<p>' + task.prompt.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
            inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
            await delay(400);
        }

        console.log('[QuizAI Bridge] Final input text (first 80 chars):', (inputEl.innerText || '').slice(0, 80));

        // ── 5. Click Send ────────────────────────────────────────────────────────────
        await delay(600); // let React enable the Send button

        const sendBtn = await waitForEl([
            'button[aria-label="Send message"]',  // confirmed ✓
            'button[aria-label="Send Message"]',
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
        ], 5000);

        if (activeTaskId !== task.taskId) return;
        if (Date.now() >= deadline) { await storeError('Task expired before sending. Try again.'); return; }
        await updateProgress('sending_prompt');

        if (sendBtn && !sendBtn.disabled) {
            console.log('[QuizAI Bridge] Clicking Send...');
            sendBtn.click();
        } else {
            console.warn('[QuizAI Bridge] Send button not found — pressing Enter');
            inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
        }

        console.log('[QuizAI Bridge] Message sent. Waiting for NEW response elements...');
        await delay(3000); // give Claude time to start generating

        let responseText;
        try {
            responseText = await CqsAI.waitForResponse(readResponse, {
                timeoutMs: deadline - Date.now(),
                isProcessing: text => CqsAI.isProviderProcessing('claude', text),
                isComplete: CqsAI.hasCompleteResponseEnvelope,
                isCancelled: () => activeTaskId !== task.taskId,
                onProgress: progress => { updateProgress(progress.stage, { characters: progress.characters }).catch(() => {}); },
            });
        } catch (error) {
            if (activeTaskId === task.taskId) await storeError(error.message);
            return;
        }

        console.log('[QuizAI Bridge] Stable response (', responseText.length, ' chars)');

        if (!responseText.trim()) {
            await storeError('Claude response was empty. Try again.');
            return;
        }

        // ── 8. Parse and store ───────────────────────────────────────────────────────
        const answers = CqsAI.normalizeAnswers(parseClaudeResponse(responseText));
        if (activeTaskId !== task.taskId) return;
        await updateProgress('response_captured', { characters: responseText.length, answers: answers.length, expected: task.expectedAnswers || 0 });
        console.log('[QuizAI Bridge] Parsed', answers.length, 'answers');

        await chrome.storage.local.set({
            [ANSWER_KEY]: {
                answers,
                rawText: responseText,
                taskId: task.taskId,
                timestamp: Date.now(),
            }
        });
        await chrome.storage.local.remove([TASK_KEY]);

        showBanner(`✅ Quiz AI: ${answers.length} answers from Claude! Switch back to Coursera.`);
        console.log('[QuizAI Bridge] ✅ Done.');

        // ──────────────────────────────────────────────────────────────────────────────
        //  HELPERS
        // ──────────────────────────────────────────────────────────────────────────────

        function waitForEl(sels, maxMs) {
            return new Promise(resolve => {
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (el) { resolve(el); return; }
                }
                const start = Date.now();
                const id = setInterval(() => {
                    for (const sel of sels) {
                        const el = document.querySelector(sel);
                        if (el) { clearInterval(id); resolve(el); return; }
                    }
                    if (Date.now() - start > maxMs) { clearInterval(id); resolve(null); }
                }, 400);
            });
        }

        // Paste base64 screenshots into Claude's input as image attachments
        async function pasteImages(inputEl, screenshots) {
            for (const { q, dataUrl } of screenshots) {
                try {
                    const res = await fetch(dataUrl);
                    const blob = await res.blob();
                    const dt = new DataTransfer();
                    dt.items.add(new File([blob], `question_${q}.png`, { type: 'image/png' }));
                    inputEl.focus();
                    inputEl.dispatchEvent(new ClipboardEvent('paste', {
                        clipboardData: dt,
                        bubbles: true,
                        cancelable: true
                    }));
                    console.log(`[QuizAI Bridge] Pasted screenshot for Q${q}`);
                    await delay(800);
                } catch (e) {
                    console.warn(`[QuizAI Bridge] Failed to paste image for Q${q}:`, e);
                }
            }
        }

        function parseClaudeResponse(text, skipRegexFallback = false) {
            // 1. Extract all complete JSON objects using brace-balancing
            const candidates = CqsAI.extractJsonObjects(text);
            // Try largest candidate first (most complete JSON blob)
            for (const candidate of [...candidates].reverse()) {
                try {
                    const p = JSON.parse(candidate);
                    if (Array.isArray(p.answers) && p.answers.length) {
                        console.log('[QuizAI Bridge] JSON parsed successfully, answers:', p.answers.length);
                        return p.answers;
                    }
                } catch { /* try next */ }
            }

            // 2. Sanitize-then-parse: replace unescaped internal quotes with apostrophes
            for (const candidate of [...candidates].reverse()) {
                try {
                    const sanitized = candidate.replace(/:\s*"((?:[^"\\]|\\.)*)"/g, (match, inner) => {
                        const fixed = inner.replace(/(?<!\\)"/g, "'");
                        return ': "' + fixed + '"';
                    });
                    const p = JSON.parse(sanitized);
                    if (Array.isArray(p.answers) && p.answers.length) return p.answers;
                } catch { /* try next */ }
            }

            if (skipRegexFallback) return [];

            // 3. Regex extraction — handles both letter and open-ended text answers, plus scoreIndex for peer review
            const customRes = [];
            const qBlocks = [...text.matchAll(/"q"\s*:\s*(\d+)\s*,\s*(?:"text"\s*:\s*"([\s\S]*?)"|"a"\s*:\s*\[([\s\S]*?)\])(?:\s*,\s*"scoreIndex"\s*:\s*(\d+))?/g)];
            if (qBlocks.length > 0) {
                for (const m of qBlocks) {
                    const q = parseInt(m[1]);
                    const scoreIndexStr = m[4];
                    let rawA = (m[2] || m[3] || '').trim();
                    let ansObj = { q };

                    if (scoreIndexStr !== undefined) {
                        ansObj.scoreIndex = parseInt(scoreIndexStr);
                    }

                    if (/^"[A-H]"(?:\s*,\s*"[A-H]")*$/.test(rawA)) {
                        ansObj.a = [...rawA.matchAll(/"([A-H])"/g)].map(x => x[1]);
                        customRes.push(ansObj);
                    } else {
                        let extracted = rawA;
                        if (extracted.startsWith('"')) extracted = extracted.substring(1);
                        if (extracted.endsWith('"')) extracted = extracted.substring(0, extracted.length - 1);
                        extracted = extracted.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
                        if (extracted.length > 2) {
                            ansObj.a = [extracted];
                            customRes.push(ansObj);
                        }
                    }
                }
                if (customRes.length > 0) return customRes;
            }

            // 4. Block-by-block fallback (Handles conversational multi-line answers)
            const result = [];
            const blocks = text.split(/(?:(?:\*\*|^|\n)\s*(?:Q|Question)\s*(\d+)[:.)\s])/i);
            for (let i = 1; i < blocks.length; i += 2) {
                const q = parseInt(blocks[i]);
                const content = blocks[i + 1] || '';
                const letterMatches = [...content.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?([A-H])(?:\*\*|[.)])\s+/g)];
                if (letterMatches.length > 0) {
                    const letters = letterMatches.map(m => m[1].toUpperCase());
                    result.push({ q, a: [...new Set(letters)] });
                } else {
                    let txt = content;
                    const ansMatch = content.match(/Answer\s*:\s*([\s\S]+?)(?:\n\nExplanation|\n\n$|$)/i);
                    if (ansMatch) txt = ansMatch[1];
                    txt = txt.replace(/\*/g, '').trim();
                    if (txt.length > 2) result.push({ q, a: [txt] });
                }
            }
            return result;
        }

        async function storeError(msg) {
            if (activeTaskId !== task.taskId) return;
            await updateProgress('error', { message: msg });
            console.error('[QuizAI Bridge] ERROR:', msg);
            await chrome.storage.local.set({ [ANSWER_KEY]: { error: msg, taskId: task.taskId, timestamp: Date.now() } });
            await chrome.storage.local.remove([TASK_KEY]);
            showBanner('⚠ Quiz AI: ' + msg);
        }

        async function updateProgress(stage, details = {}) {
            if (activeTaskId !== task.taskId) return;
            await chrome.storage.local.set({ [PROGRESS_KEY]: { taskId: task.taskId, stage, timestamp: Date.now(), ...details } });
            if (stage !== lastProgressStage) {
                lastProgressStage = stage;
                globalThis.CqsDebug?.log('claude', stage, { taskId: task.taskId, ...details }, stage === 'error' ? 'error' : 'info');
            }
        }

        function showBanner(msg) {
            const b = document.createElement('div');
            b.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;max-width:380px;' +
                'background:#0f172a;border:1.5px solid #6366f1;border-radius:14px;' +
                'padding:14px 20px;font-family:Inter,system-ui,sans-serif;font-size:13px;' +
                'font-weight:600;color:#f8fafc;box-shadow:0 8px 40px rgba(0,0,0,0.6);line-height:1.5;';
            b.textContent = msg;
            document.body.appendChild(b);
            setTimeout(() => b.remove(), 12000);
        }

        function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    } // End of handleTask

})();
