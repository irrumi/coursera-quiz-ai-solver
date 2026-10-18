(function (root) {
    'use strict';
    const quizPath = /\/(quiz|exam|assignment-submission)\//;
    function canonicalUrl(href, base = root.location?.href) {
        try {
            const url = new URL(href, base);
            if (!/(^|\.)coursera\.org$/.test(url.hostname) || !quizPath.test(url.pathname)) return null;
            const item = url.pathname.match(/^(\/learn\/[^/]+\/(?:quiz|exam|assignment-submission)\/[^/]+)(?:\/([^/]+))?/);
            if (!item) return null;
            const slug = item[2] && !/^(view-feedback|attempt|start|submit)$/.test(item[2]) ? '/' + item[2] : '';
            return url.origin + item[1] + slug;
        } catch { return null; }
    }
    function quizUrls(element) {
        return new Set([...element.querySelectorAll('a[href]')].map(link => canonicalUrl(link.href)).filter(Boolean));
    }
    function findRow(link) {
        let node = link.parentElement, best = node;
        for (let depth = 0; node && node !== root.document.body && depth < 12; depth++, node = node.parentElement) {
            if (quizUrls(node).size > 1) break;
            if ([...node.querySelectorAll('a[href]')].some(other => other !== link && /\/(lecture|supplement|reading|peer|ungradedLab)\//.test(other.href))) break;
            best = node;
            if (node.matches('tr, li, [role="row"], .cds-table-row, [data-testid*="assignment-row"], [class*="TableRow"]')) return node;
        }
        return best;
    }
    function classifyText(text, labels = [], disabled = false) {
        const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const all = value + ' ' + labels.join(' ').toLowerCase();
        if (/didn['’]t pass|did not pass|not passed|\bfailed\b|не сдан|не пройден/.test(all)) return { status: 'failed', reason: 'failed_attempt', queued: !disabled };
        if (/not completed|not complete\b|\bincomplete\b|not started|not submitted|\bin progress\b|no submission|не выполнен|не начат|не отправлен/.test(all)) return { status: 'pending', reason: 'unfinished', queued: !disabled };
        const fraction = all.match(/(\d+)\s*\/\s*(\d+)\s*(?:\w+\s+)?completed/);
        const percent = all.match(/(\d+(?:\.\d+)?)%\s*completed?/);
        if ((fraction && Number(fraction[1]) < Number(fraction[2])) || (percent && Number(percent[1]) < 100)) return { status: 'pending', reason: 'partial_progress', queued: !disabled };
        if (disabled || /\blocked\b|not available|unavailable|заблокирован|недоступ/.test(all)) return { status: 'locked', reason: 'unavailable', queued: false };
        if (/\bpassed\b|\bcompleted\b|\bfinished\b|успешно пройден|выполнено|завершено|сдано/.test(all) || /^(complete|done)$/.test(value) || labels.some(label => /^(complete|done)$/i.test(label.trim()))) return { status: 'completed', reason: 'explicit_completion', queued: false };
        if (/\bsubmitted\b|awaiting|\bgrading\b|\bpending review\b|на проверке|отправлено/.test(all)) return { status: 'waiting', reason: 'awaiting_grade', queued: false };
        if (labels.some(label => /^(checkmark|check circle|success|verified)$/i.test(label.trim()))) return { status: 'completed', reason: 'completion_icon', queued: false };
        if (/\bstart\b|\bresume\b|\bcontinue\b|\bretry\b|\boverdue\b|начать|продолжить|повторить/.test(value)) return { status: 'pending', reason: 'action_available', queued: true };
        return { status: 'unknown', reason: 'status_not_visible', queued: true };
    }
    function classifyRow(row, link) {
        if (!row) return classifyText('', [], link.getAttribute('aria-disabled') === 'true');
        const visibleText = node => {
            if (node.nodeType === 3) return node.textContent;
            if (node.nodeType !== 1 || /^(A|H[1-6]|SCRIPT|STYLE)$/.test(node.tagName) || !root.CqsAI.isVisible(node)) return '';
            return [...node.childNodes].map(visibleText).join(' ');
        };
        const labels = [...row.querySelectorAll('[aria-label], img[alt], svg title')]
            .filter(el => root.CqsAI.isVisible(el.tagName.toLowerCase() === 'title' ? el.closest('svg') : el) && !link.contains(el))
            .map(el => el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent || '');
        const disabled = link.getAttribute('aria-disabled') === 'true' || link.hasAttribute('disabled');
        return classifyText(visibleText(row), labels, disabled);
    }
    function scan(doc = root.document) {
        const byUrl = new Map();
        for (const link of doc.querySelectorAll('a[href]')) {
            const url = canonicalUrl(link.href);
            if (!url || !root.CqsAI.isVisible(link)) continue;
            const row = findRow(link);
            const item = { url, title: (link.innerText || link.textContent || 'Quiz').trim().slice(0, 160), ...classifyRow(row, link) };
            const previous = byUrl.get(url);
            if (!previous || previous.status === 'unknown' || (!item.queued && previous.queued)) byUrl.set(url, item);
        }
        const items = [...byUrl.values()];
        const counts = { total: items.length, completed: 0, pending: 0, failed: 0, waiting: 0, locked: 0, unknown: 0 };
        items.forEach(item => { counts[item.status]++; });
        return { timestamp: Date.now(), items, counts };
    }
    function pageStatus(doc = root.document) {
        const source = doc.querySelector('main') || doc.body;
        let text = source?.innerText || '';
        for (const part of source?.querySelectorAll?.('[data-testid^="part-Submission_"], .rc-FormPartsQuestion, .cqs-new-badge, #cqs-toolbar') || []) {
            if (part.innerText) text = text.replace(part.innerText, '');
        }
        if (/you (?:didn['’]t|did not) pass|you (?:have )?failed/i.test(text)) return 'failed';
        if (/you (?:have )?passed|you successfully completed|вы успешно прошли|вы сдали/i.test(text)) return 'completed';
        if (/your (?:quiz|assignment|submission) (?:has been|was|is) submitted|submission received|submitted successfully/i.test(text)) return 'submitted';
        return 'unknown';
    }
    root.CqsQuizzes = Object.freeze({ canonicalUrl, findRow, classifyText, classifyRow, scan, pageStatus });
})(globalThis);
