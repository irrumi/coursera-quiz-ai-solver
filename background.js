import './diagnostics.js';

const providers = {
  chatgpt: { pattern: '*://chatgpt.com/*', url: 'https://chatgpt.com/', taskKey: 'cqsChatGptTask', bridge: 'chatgpt_bridge.js' },
  claude: { pattern: '*://claude.ai/*', url: 'https://claude.ai/new', taskKey: 'cqsClaudeTask', bridge: 'claude_bridge.js' },
};

async function openProvider(provider, taskId) {
  const config = providers[provider];
  const tabs = await chrome.tabs.query({ url: config.pattern });
  const tab = tabs.find(item => item.active) || tabs[0] || await chrome.tabs.create({ url: config.url, active: true });
  if (taskId) {
    const data = await chrome.storage.local.get([config.taskKey]);
    if (data[config.taskKey]?.taskId !== taskId) throw new Error('AI task was cancelled before the tab opened.');
    await chrome.storage.local.set({ [config.taskKey]: { ...data[config.taskKey], targetTabId: tab.id } });
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const deadline = Date.now() + 20000;
  while ((await chrome.tabs.get(tab.id)).status === 'loading' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  let ping;
  try { ping = await chrome.tabs.sendMessage(tab.id, { type: 'CQS_BRIDGE_PING' }); } catch { /* A tab opened before an extension update may lack the bridge. */ }
  if (!ping?.ok || ping.version !== chrome.runtime.getManifest().version) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['ai_common.js', 'diagnostics.js', config.bridge] });
    ping = await chrome.tabs.sendMessage(tab.id, { type: 'CQS_BRIDGE_PING' });
  }
  if (!ping?.ok) throw new Error('AI bridge did not respond. Refresh the AI tab and open Debug.');
  await CqsDebug.record({ source: 'background', event: 'bridge_ready', details: { provider, taskId: taskId || '', tabId: tab.id, version: ping.version } });
  return { ok: true, tabId: tab.id };
}

async function handleMessage(message, sender) {
  if (message.type === 'CQS_DEBUG_EVENT') {
    await CqsDebug.record(message.entry);
    return { ok: true };
  }
  if (message.type === 'OPEN_DEBUG') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
    return { ok: true };
  }
  if (message.type === 'CQS_DEBUG_REPORT') {
    const report = await CqsDebug.report();
    report.connections = {};
    for (const [provider, config] of Object.entries(providers)) {
      const tabs = await chrome.tabs.query({ url: config.pattern });
      const pings = await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'CQS_BRIDGE_PING' }).catch(() => null)));
      report.connections[provider] = { openTabs: tabs.length, readyTabs: pings.filter(ping => ping?.ok).length,
        versions: pings.filter(ping => ping?.ok).map(ping => ping.version) };
    }
    return { ok: true, report };
  }
  if (message.type === 'CQS_DEBUG_CLEAR') {
    await chrome.storage.local.remove(['cqsDebugLog']);
    return { ok: true };
  }
  if (message.type === 'CQS_CLAIM_TASK') {
    const config = providers[message.provider];
    if (!config || !sender.tab) return { ok: false };
    const data = await chrome.storage.local.get([config.taskKey]);
    const task = data[config.taskKey];
    return { ok: task?.taskId === message.taskId && task.targetTabId === sender.tab.id };
  }
  if (message.type === 'OPEN_CHATGPT_TAB') return openProvider('chatgpt', message.taskId);
  if (message.type === 'OPEN_CLAUDE_TAB') return openProvider('claude', message.taskId);
  if (message.type === 'CAPTURE_SCREENSHOT') {
    if (!sender.tab?.windowId) return { error: 'No browser window for screenshot capture.' };
    return { dataUrl: await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }) };
  }
  return { ok: false, error: 'Unknown extension message.' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['CQS_DEBUG_EVENT', 'OPEN_DEBUG', 'CQS_DEBUG_REPORT', 'CQS_DEBUG_CLEAR', 'CQS_CLAIM_TASK', 'OPEN_CHATGPT_TAB', 'OPEN_CLAUDE_TAB', 'CAPTURE_SCREENSHOT'].includes(message.type)) return false;
  handleMessage(message, sender).then(sendResponse).catch(async error => {
    await CqsDebug.record({ source: 'background', event: 'message_failed', level: 'error', details: { code: message.type, message: error.message, taskId: message.taskId || '' } }).catch(() => {});
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});
