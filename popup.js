/**
 * popup.js — UI Controller
 *
 * Bridges the popup UI (popup.html) with the background service worker.
 * Handles:
 *  - Saving / loading auth token, URLs, and preferences via chrome.storage.local
 *  - Sending commands (INJECT_TOKEN, START_WORKFLOW, STOP_WORKFLOW) to background
 *  - Rendering live status logs and stats from background messages
 */

(function () {
  'use strict';

  /* ────────────────────────────────────────────────────────────────
   *  DOM References
   * ──────────────────────────────────────────────────────────────── */

  const $ = (id) => document.getElementById(id);

  const authTokenInput = $('authToken');
  const communityUrlsTextarea = $('communityUrls');
  const postContentTextarea = $('postContent');
  const autoFollowToggle = $('autoFollowToggle');
  const btnInject = $('btnInjectToken');
  const btnStart = $('btnStart');
  const btnStop = $('btnStop');
  const btnClearStats = $('btnClearStats');
  const btnClearLog = $('btnClearLog');
  const logArea = $('logArea');
  const logCount = $('logCount');
  const statusBadge = $('statusBadge');
  const statJoined = $('statJoined');
  const statPosted = $('statPosted');
  const statFollowed = $('statFollowed');

  /* ────────────────────────────────────────────────────────────────
   *  State
   * ──────────────────────────────────────────────────────────────── */

  let logEntries = [];
  let isRunning = false;

  /* ────────────────────────────────────────────────────────────────
   *  Initialisation — load saved prefs
   * ──────────────────────────────────────────────────────────────── */

  chrome.storage.local.get(
    ['authToken', 'communityUrls', 'postContent', 'autoFollow'],
    (items) => {
      if (items.authToken) authTokenInput.value = items.authToken;
      if (items.communityUrls) communityUrlsTextarea.value = items.communityUrls;
      if (items.postContent) postContentTextarea.value = items.postContent;
      if (items.autoFollow !== undefined)
        autoFollowToggle.checked = items.autoFollow;
    }
  );

  // Persist input changes back to storage
  authTokenInput.addEventListener('input', () =>
    chrome.storage.local.set({ authToken: authTokenInput.value })
  );
  communityUrlsTextarea.addEventListener('input', () =>
    chrome.storage.local.set({ communityUrls: communityUrlsTextarea.value })
  );
  postContentTextarea.addEventListener('input', () =>
    chrome.storage.local.set({ postContent: postContentTextarea.value })
  );
  autoFollowToggle.addEventListener('change', () =>
    chrome.storage.local.set({ autoFollow: autoFollowToggle.checked })
  );

  /* ────────────────────────────────────────────────────────────────
   *  Logging
   * ──────────────────────────────────────────────────────────────── */

  /** Append a message to the on-screen log. */
  function appendLog(level, message, timestamp) {
    const time = timestamp
      ? new Date(timestamp).toLocaleTimeString()
      : new Date().toLocaleTimeString();

    logEntries.push({ level, message, time });

    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.innerHTML = `<span class="log-time">${escapeHtml(time)}</span>${escapeHtml(message)}`;
    logArea.appendChild(entry);
    logArea.scrollTop = logArea.scrollHeight;

    logCount.textContent = `${logEntries.length} entries`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Clear the on-screen log. */
  function clearLog() {
    logEntries = [];
    logArea.innerHTML = '';
    logCount.textContent = '0 entries';
    appendLog('info', 'Log cleared.');
  }

  /* ────────────────────────────────────────────────────────────────
   *  UI State Updates
   * ──────────────────────────────────────────────────────────────── */

  function setRunning(running) {
    isRunning = running;
    btnStart.disabled = running;
    btnStop.disabled = !running;
    statusBadge.textContent = running ? 'Running' : 'Idle';
    statusBadge.className = `status-badge ${running ? 'running' : ''}`;
  }

  function updateStats(stats) {
    if (!stats) return;
    statJoined.textContent = stats.joined ?? 0;
    statPosted.textContent = stats.posted ?? 0;
    statFollowed.textContent = stats.followed ?? 0;
  }

  /* ────────────────────────────────────────────────────────────────
   *  Message Listener (from background.js)
   * ──────────────────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'LOG':
        appendLog(msg.level, msg.message, msg.timestamp);
        break;

      case 'STATS_UPDATE':
        updateStats(msg.stats);
        setRunning(msg.running);
        statusBadge.textContent = msg.running ? 'Running' : 'Idle';
        break;

      case 'STATUS':
        statusBadge.textContent = isRunning ? msg.text || 'Running' : 'Idle';
        break;

      default:
        break;
    }
  });

  /* ────────────────────────────────────────────────────────────────
   *  Button Handlers
   * ──────────────────────────────────────────────────────────────── */

  // ── Inject Token ───────────────────────────────────────────────
  btnInject.addEventListener('click', async () => {
    const token = authTokenInput.value.trim();
    if (!token) {
      appendLog('warn', '⚠️ Please enter an auth_token first.');
      return;
    }

    btnInject.disabled = true;
    btnInject.textContent = 'Injecting…';

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'INJECT_TOKEN',
        token,
      });

      if (resp?.success) {
        appendLog('success', '✅ Auth token injected. Opening X…');
      } else {
        appendLog('error', `❌ Token injection failed: ${resp?.error || 'Unknown error'}`);
      }
    } catch (err) {
      appendLog('error', `❌ ${err.message}`);
    } finally {
      btnInject.disabled = false;
      btnInject.textContent = 'Inject Token & Authenticate';
    }
  });

  // ── Start Workflow ─────────────────────────────────────────────
  btnStart.addEventListener('click', async () => {
    const communityUrls = communityUrlsTextarea.value.trim();
    const postContent = postContentTextarea.value.trim();
    const autoFollow = autoFollowToggle.checked;

    if (!communityUrls && !autoFollow) {
      appendLog('warn', '⚠️ Provide community URLs or enable Auto Follow-Back.');
      return;
    }

    btnStart.disabled = true;
    btnStart.textContent = 'Starting…';

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'START_WORKFLOW',
        communityUrls,
        postContent,
        autoFollow,
      });

      if (resp?.success) {
        appendLog('success', `🚀 Workflow started with ${resp.taskCount} tasks.`);
        setRunning(true);
      } else {
        appendLog('error', `❌ Failed to start: ${resp?.error || 'Unknown error'}`);
        btnStart.disabled = false;
        btnStart.textContent = '▶ Start Workflow';
      }
    } catch (err) {
      appendLog('error', `❌ ${err.message}`);
      btnStart.disabled = false;
      btnStart.textContent = '▶ Start Workflow';
    }
  });

  // ── Stop Workflow ──────────────────────────────────────────────
  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping…';

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'STOP_WORKFLOW' });
      if (resp?.success) {
        appendLog('warn', '🛑 Workflow stopped.');
        setRunning(false);
      }
    } catch (err) {
      appendLog('error', `❌ ${err.message}`);
    } finally {
      btnStop.disabled = false;
      btnStop.textContent = '■ Stop';
    }
  });

  // ── Clear Stats ────────────────────────────────────────────────
  btnClearStats.addEventListener('click', async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CLEAR_STATS' });
      if (resp?.success) {
        updateStats({ joined: 0, posted: 0, followed: 0 });
        appendLog('info', '📊 Stats reset.');
      }
    } catch (err) {
      appendLog('error', `❌ ${err.message}`);
    }
  });

  // ── Clear Log ──────────────────────────────────────────────────
  btnClearLog.addEventListener('click', clearLog);

  /* ────────────────────────────────────────────────────────────────
   *  On Open — fetch current state from background
   * ──────────────────────────────────────────────────────────────── */

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
    if (resp) {
      setRunning(resp.running);
      updateStats(resp.stats);

      if (resp.running) {
        appendLog('info', 'Workflow is currently running in the background.');
      }
    }
  });

  appendLog('info', 'Xpert Engage ready. Configure your settings and start.');

  console.log('[Xpert Engage] popup.js loaded.');
})();