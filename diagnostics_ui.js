'use strict';
let currentReport = null;
const status = document.getElementById('status');
async function refresh() {
    try {
        const result = await chrome.runtime.sendMessage({ type: 'CQS_DEBUG_REPORT' });
        if (!result?.ok) throw new Error(result?.error || 'Could not reach the extension background worker.');
        currentReport = result.report;
        document.getElementById('report').textContent = JSON.stringify(currentReport, null, 2);
        const lastError = [...currentReport.events].reverse().find(event => event.level === 'error');
        status.textContent = `Version ${currentReport.version}. ${lastError ? `Last error: ${lastError.source} / ${lastError.event}: ${lastError.details.message || lastError.details.code || ''}` : 'No errors recorded.'}`;
        const { cqsQuizScan: scan } = await chrome.storage.local.get(['cqsQuizScan']);
        const body = document.getElementById('scan-items');
        body.replaceChildren();
        if (scan) {
            const c = scan.counts;
            document.getElementById('scan-summary').textContent = `${c.total} quizzes — ${c.completed} completed, ${c.pending} pending, ${c.failed} failed, ${c.waiting} awaiting grade, ${c.locked} locked, ${c.unknown} to check.`;
            for (const item of scan.items) {
                const row = document.createElement('tr');
                for (const value of [item.title, item.status, item.queued ? 'Yes' : 'Skip', item.reason]) {
                    const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
                }
                body.appendChild(row);
            }
        }
    } catch (error) { status.textContent = `Debug error: ${error.message}. Reload the extension and refresh this page.`; }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('copy').addEventListener('click', async () => {
    if (!currentReport) return;
    try { await navigator.clipboard.writeText(JSON.stringify(currentReport, null, 2)); status.textContent = 'Report copied.'; }
    catch (error) { status.textContent = `Copy failed: ${error.message}`; }
});
document.getElementById('download').addEventListener('click', () => {
    if (!currentReport) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(currentReport, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'quiz-ai-debug.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.getElementById('clear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CQS_DEBUG_CLEAR' }); await refresh();
});
refresh();
