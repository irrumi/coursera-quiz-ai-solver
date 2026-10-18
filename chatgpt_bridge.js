// chatgpt_bridge.js — runs on chatgpt.com/* (Chrome extension content script)

(async function () {
    'use strict';
    const bridgeVersion = chrome.runtime.getManifest().version;
    if (globalThis.__cqsChatGptBridgeVersion === bridgeVersion) return;
    globalThis.__cqsChatGptBridgeVersion = bridgeVersion;

    const TASK_KEY = 'cqsChatGptTask';
    const ANSWER_KEY = 'cqsChatGptAnswers';
    const PROGRESS_KEY = 'cqsChatGptProgress';
    let activeTaskId = null;
    globalThis.CqsDebug?.attach('chatgpt');
    chrome.runtime.onMessage.addListener((message, _, reply) => {
        if (message.type === 'CQS_BRIDGE_PING') reply({ ok: true, provider: 'chatgpt', version: bridgeVersion });
    });
    function launchTask(task) {
        handleTask(task).catch(async error => {
            if (activeTaskId !== task.taskId) return;
            globalThis.CqsDebug?.log('chatgpt', 'task_failed', { taskId: task.taskId, message: error.message }, 'error');
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
        const claim = await chrome.runtime.sendMessage({ type: 'CQS_CLAIM_TASK', provider: 'chatgpt', taskId: task.taskId });
        if (!claim?.ok || activeTaskId === task.taskId) return;
        activeTaskId = task.taskId;
        let lastProgressStage = '';
        const deadline = task.deadline || Date.now() + CqsAI.DEFAULT_SETTINGS.responseTimeoutSeconds * 1000;
        await updateProgress('finding_editor');

        console.log('[QuizAI Bridge] ✅ Task found. Prompt length:', task.prompt.length);

        // Use the task's selected deadline, including React hydration.
        globalThis.CqsDebug?.log('chatgpt', 'dom_snapshot', { taskId: task.taskId, ...CqsAI.chatGptDomStatus() });
        const inputEl = await waitForElement(() => CqsAI.findChatGptEditor(), deadline);
        if (activeTaskId !== task.taskId) return;

        if (!inputEl) {
            await storeError('ChatGPT editor not found before the selected timeout. Check the chat tab and open Debug.', 'EDITOR_NOT_FOUND');
            return;
        }

        console.log('[QuizAI Bridge] Input found:', inputEl.tagName, inputEl.id);

        // ── 3. Snapshot baseline BEFORE sending ──────────────────────────────────────
        const readResponse = CqsAI.createResponseTracker(() => CqsAI.getChatGptResponses());
        await updateProgress('inserting_prompt');

        // ── 4. Paste question screenshots (for vision/image questions) ────────────
        if (Array.isArray(task.screenshots) && task.screenshots.length > 0) {
            console.log(`[QuizAI Bridge] Pasting ${task.screenshots.length} screenshot(s) for vision questions...`);
            await pasteImages(inputEl, task.screenshots);
            await delay(1500); // wait for ChatGPT to process attachments
        }

        // ── 5. Inject the prompt ─────────────────────────────────────────────────────
        inputEl.focus();
        await delay(300);

        if (inputEl.tagName.toLowerCase() === 'textarea') {
            // For normal textarea
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(inputEl, task.prompt);
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            // For contenteditable
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await delay(150);

            const inserted = document.execCommand('insertText', false, task.prompt);

            if (!inserted || !(inputEl.innerText || '').trim()) {
                const dt = new DataTransfer();
                dt.setData('text/plain', task.prompt);
                inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            }

            if (!(inputEl.innerText || '').trim()) {
                inputEl.textContent = task.prompt;
                inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
            }
        }

        await delay(400);

        // ── 6. Click Send ────────────────────────────────────────────────────────────
        await delay(800); // let React enable the Send button

        const sendBtn = await waitForElement(() => CqsAI.findChatGptSendButton(inputEl), Math.min(deadline, Date.now() + 15000));

        if (activeTaskId !== task.taskId) return;
        if (Date.now() >= deadline) { await storeError('Task expired before sending. Try again.'); return; }
        await updateProgress('sending_prompt');

        if (sendBtn) {
            console.log('[QuizAI Bridge] Clicking Send...');
            sendBtn.click();
        } else {
            await storeError('ChatGPT Send button was not available. The prompt remains in the editor; it was not sent.', 'SEND_BUTTON_NOT_FOUND');
            return;
        }

        console.log('[QuizAI Bridge] Message sent. Waiting for NEW response elements...');
        await delay(3000); // give ChatGPT time to start generating

        let responseText;
        try {
            responseText = await CqsAI.waitForResponse(readResponse, {
                timeoutMs: deadline - Date.now(),
                isProcessing: isChatGPTProcessing,
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
            await storeError('ChatGPT response was empty. Try again.');
            return;
        }

        // ── 8. Parse and store ───────────────────────────────────────────────────────
        // parseChatGPTResponse returns { answers, uploadFileSvg }
        const parsed = parseChatGPTResponse(responseText);
        const answers = CqsAI.normalizeAnswers(parsed.answers);
        const uploadFileSvg = parsed.uploadFileSvg;
        if (activeTaskId !== task.taskId) return;
        await updateProgress('response_captured', { characters: responseText.length, answers: answers.length, expected: task.expectedAnswers || 0 });
        console.log('[QuizAI Bridge] Parsed', answers.length, 'answers');
        if (uploadFileSvg) console.log('[QuizAI Bridge] Got uploadFileSvg (' + uploadFileSvg.length + ' chars)');

        await chrome.storage.local.set({
            [ANSWER_KEY]: {
                answers,
                uploadFileSvg: uploadFileSvg || null,  // pass through to content.js for file upload
                rawText: responseText,
                taskId: task.taskId,
                timestamp: Date.now(),
            }
        });
        await chrome.storage.local.remove([TASK_KEY]);

        showBanner(`✅ Quiz AI: ${answers.length} answers from ChatGPT! Switch back to Coursera.`);
        console.log('[QuizAI Bridge] ✅ Done.');

        // ──────────────────────────────────────────────────────────────────────────────
        //  HELPERS
        // ──────────────────────────────────────────────────────────────────────────────

        async function waitForElement(find, until) {
            while (activeTaskId === task.taskId && Date.now() < until) {
                const element = find();
                if (element) return element;
                await delay(Math.min(400, until - Date.now()));
            }
            return null;
        }

        // Paste base64 screenshots into ChatGPT's input as image attachments
        async function pasteImages(inputEl, screenshots) {
            for (const { q, dataUrl } of screenshots) {
                try {
                    // Convert base64 dataURL → Blob
                    const res = await fetch(dataUrl);
                    const blob = await res.blob();

                    // Build a DataTransfer with the image blob
                    const dt = new DataTransfer();
                    dt.items.add(new File([blob], `question_${q}.png`, { type: 'image/png' }));

                    // Dispatch paste event on the input element
                    inputEl.focus();
                    inputEl.dispatchEvent(new ClipboardEvent('paste', {
                        clipboardData: dt,
                        bubbles: true,
                        cancelable: true
                    }));
                    console.log(`[QuizAI Bridge] Pasted screenshot for Q${q}`);
                    await delay(800); // give ChatGPT time to process each attachment
                } catch (e) {
                    console.warn(`[QuizAI Bridge] Failed to paste image for Q${q}:`, e);
                }
            }
        }

        function isChatGPTProcessing(text) {
            return CqsAI.isProviderProcessing('chatgpt', text);
        }

        // Returns { answers: [...], uploadFileSvg: "<svg>...</svg>" | null }
        function parseChatGPTResponse(text, skipRegexFallback = false) {
            // 1. Brace-balanced JSON extraction
            const candidates = CqsAI.extractJsonObjects(text);

            // Try largest candidate first — also extract root-level uploadFileSvg
            for (const candidate of [...candidates].reverse()) {
                try {
                    const p = JSON.parse(candidate);
                    if (Array.isArray(p.answers) && p.answers.length) {
                        return { answers: p.answers, uploadFileSvg: p.uploadFileSvg || null };
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
                    if (Array.isArray(p.answers) && p.answers.length) {
                        return { answers: p.answers, uploadFileSvg: p.uploadFileSvg || null };
                    }
                } catch { /* try next */ }
            }

            if (skipRegexFallback) return { answers: [] };

            // 3. Regex extraction — handles both letter and open-ended answers, plus scoreIndex for peer review
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
                if (customRes.length > 0) return { answers: customRes, uploadFileSvg: null };
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
            if (result.length > 0) return { answers: result, uploadFileSvg: null };
            return { answers: [], uploadFileSvg: null };
        }

        async function storeError(msg, code = 'BRIDGE_ERROR') {
            if (activeTaskId !== task.taskId) return;
            await updateProgress('error', { message: msg, code, ...CqsAI.chatGptDomStatus() });
            console.error('[QuizAI Bridge] ERROR:', msg);
            await chrome.storage.local.set({ [ANSWER_KEY]: { error: msg, code, taskId: task.taskId, timestamp: Date.now() } });
            await chrome.storage.local.remove([TASK_KEY]);
            showBanner('⚠ Quiz AI: ' + msg);
        }

        async function updateProgress(stage, details = {}) {
            if (activeTaskId !== task.taskId) return;
            await chrome.storage.local.set({ [PROGRESS_KEY]: { taskId: task.taskId, stage, timestamp: Date.now(), ...details } });
            if (stage !== lastProgressStage) {
                lastProgressStage = stage;
                globalThis.CqsDebug?.log('chatgpt', stage, { taskId: task.taskId, ...details }, stage === 'error' ? 'error' : 'info');
            }
        }

        function showBanner(msg) {
            const b = document.createElement('div');
            b.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;max-width:380px;' +
                'background:#10a37f;border:1.5px solid #054a38;border-radius:14px;' +
                'padding:14px 20px;font-family:Inter,system-ui,sans-serif;font-size:13px;' +
                'font-weight:600;color:#ffffff;box-shadow:0 8px 40px rgba(0,0,0,0.6);line-height:1.5;';
            b.textContent = msg;
            document.body.appendChild(b);
            setTimeout(() => b.remove(), 12000);
        }

        function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    } // End of handleTask

})();
