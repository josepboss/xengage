/**
 * background.js — Task Orchestrator & Session Manager
 *
 * Service worker that orchestrates the automation workflow:
 * 1. Injects auth_token cookie to authenticate the X session
 * 2. Builds an interleaved task queue (join, post, follow)
 * 3. Manages a stable automation tab with retry logic
 * 4. Enforces anti-suspension delays (4-7 min between tasks)
 * 5. Streams status updates back to the popup via chrome.runtime messaging
 *
 * Manifest V3 service worker — all mutable state persists in
 * chrome.storage.local for reliability across worker restarts.
 */

/* ────────────────────────────────────────────────────────────────
 *  Constants
 * ──────────────────────────────────────────────────────────────── */

const DAILY_FOLLOW_LIMIT = 50;
const MICRO_BATCH_SIZE = 3;

// Anti-suspension timing (ms)
const TAB_LOAD_BUFFER_MIN = 5000;
const TAB_LOAD_BUFFER_MAX = 10000;
const TASK_INTERVAL_MIN = 4 * 60 * 1000; // 4 minutes
const TASK_INTERVAL_MAX = 7 * 60 * 1000; // 7 minutes

// Messaging
const TAB_MESSAGE_TIMEOUT_MS = 30000;
const MAX_SEND_RETRIES = 2;

/* ────────────────────────────────────────────────────────────────
 *  State (in-memory mirror of chrome.storage.local)
 * ──────────────────────────────────────────────────────────────── */

let state = {
  running: false,
  queue: [],
  stats: { joined: 0, posted: 0, followed: 0 },
  dailyFollows: 0,
  lastResetDate: null, // YYYY-MM-DD
};

/**
 * Load persisted state from chrome.storage.local and reset daily
 * counter if it's a new calendar day.
 */
async function loadState() {
  const stored = await chrome.storage.local.get([
    'running',
    'queue',
    'stats',
    'dailyFollows',
    'lastResetDate',
  ]);
  if (stored.running !== undefined) state.running = stored.running;
  if (stored.queue) state.queue = stored.queue;
  if (stored.stats) state.stats = stored.stats;
  if (stored.dailyFollows !== undefined) state.dailyFollows = stored.dailyFollows;
  if (stored.lastResetDate) state.lastResetDate = stored.lastResetDate;

  // Reset daily follow counter if day changed
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastResetDate !== today) {
    state.dailyFollows = 0;
    state.lastResetDate = today;
    await chrome.storage.local.set({ dailyFollows: 0, lastResetDate: today });
  }
}

/**
 * Persist one or more state fields to chrome.storage.local.
 */
async function persistState(fields) {
  await chrome.storage.local.set(fields);
}

/* ────────────────────────────────────────────────────────────────
 *  Logging / Status (broadcast to popup if open)
 * ──────────────────────────────────────────────────────────────── */

function logToPopup(level, message) {
  chrome.runtime
    .sendMessage({
      type: 'LOG',
      level,
      message,
      timestamp: Date.now(),
    })
    .catch(() => {});
}

function updatePopupStats() {
  chrome.runtime
    .sendMessage({
      type: 'STATS_UPDATE',
      stats: { ...state.stats },
      running: state.running,
      dailyFollows: state.dailyFollows,
    })
    .catch(() => {});
}

function setStatus(statusText) {
  chrome.runtime
    .sendMessage({ type: 'STATUS', text: statusText })
    .catch(() => {});
}

/* ────────────────────────────────────────────────────────────────
 *  Cookie / Auth Helpers
 * ──────────────────────────────────────────────────────────────── */

/**
 * Clear all existing x.com cookies, inject the provided auth_token,
 * then open x.com to let the session take effect.
 */
async function injectAuthToken(authToken) {
  const domain = '.x.com';

  // Clear all existing x.com cookies
  const existing = await chrome.cookies.getAll({ domain });
  for (const cookie of existing) {
    await chrome.cookies.remove({
      url: `https://x.com${cookie.path}`,
      name: cookie.name,
    });
  }

  // Inject the auth_token cookie
  await chrome.cookies.set({
    url: 'https://x.com',
    domain,
    name: 'auth_token',
    value: authToken,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });

  // Supplemental cookies to appear more natural
  await chrome.cookies.set({
    url: 'https://x.com',
    domain,
    name: 'lang',
    value: 'en',
    path: '/',
    secure: true,
  });

  logToPopup('success', 'Auth token injected successfully.');

  // Open x.com to establish the session (hidden tab)
  await chrome.tabs.create({ url: 'https://x.com', active: false });

  return { success: true };
}

/* ────────────────────────────────────────────────────────────────
 *  Task Queue Builder
 * ──────────────────────────────────────────────────────────────── */

/**
 * Build an interleaved task queue from user inputs.
 * Mixes join, post, and follow tasks so similar actions are never
 * performed more than 2 times in a row (organic behaviour).
 */
function buildQueue(communityUrls, postContent, autoFollowEnabled) {
  const tasks = [];

  for (const url of communityUrls) {
    const trimmed = url.trim();
    if (!trimmed) continue;

    tasks.push({ type: 'NAVIGATE', url: trimmed });
    tasks.push({ type: 'JOIN_COMMUNITY' });

    if (postContent && postContent.trim().length > 0) {
      tasks.push({ type: 'POST_MESSAGE', content: postContent.trim() });
    }
  }

  // Interleave follow-back sessions
  if (autoFollowEnabled && tasks.length > 0) {
    const insertPoints = [
      Math.floor(tasks.length * 0.25),
      Math.floor(tasks.length * 0.5),
      Math.floor(tasks.length * 0.75),
    ];

    for (const point of insertPoints) {
      const pos = Math.min(point, tasks.length);
      tasks.splice(pos, 0, {
        type: 'NAVIGATE',
        url: 'https://x.com/i/connect_people',
      });
      tasks.splice(pos + 1, 0, {
        type: 'FOLLOW_BACK',
        maxFollows: MICRO_BATCH_SIZE,
      });
    }
  }

  return tasks;
}

/* ────────────────────────────────────────────────────────────────
 *  Tab Management
 * ──────────────────────────────────────────────────────────────── */

/**
 * Create a new automation tab (hidden) and return its id.
 * If an existing tabId is provided and still valid, reuse it.
 */
async function ensureTab(existingTabId) {
  if (existingTabId) {
    try {
      await chrome.tabs.get(existingTabId);
      return existingTabId;
    } catch {
      // Tab was closed — will create a new one below
    }
  }

  const tab = await chrome.tabs.create({
    url: 'https://x.com',
    active: false,
  });

  // Wait for initial load
  await waitForTabComplete(tab.id);
  return tab.id;
}

/**
 * Wait for a tab's readyState to reach "complete".
 */
async function waitForTabComplete(tabId, pollMs = 500, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return;
    }
    await sleep(pollMs);
  }
}

/* ────────────────────────────────────────────────────────────────
 *  Content Script Messaging (with retry and injection fallback)
 * ──────────────────────────────────────────────────────────────── */

/**
 * Send a message to the content script in tabId.
 * If the content script is not loaded, inject it programmatically.
 * Retries up to MAX_SEND_RETRIES times on failure.
 */
async function sendToTab(tabId, message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
  for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
    try {
      // Probe: is the content script alive?
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'PING' });
      } catch {
        // Not loaded — inject it
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        await sleep(800); // allow initialisation
      }

      // Send the actual command with timeout
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Response timeout')),
          timeoutMs
        );
        chrome.tabs.sendMessage(tabId, message, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });

      return result;
    } catch (err) {
      if (attempt < MAX_SEND_RETRIES) {
        logToPopup('warn', `Retrying send to tab (attempt ${attempt + 2}/${MAX_SEND_RETRIES + 1})…`);
        await sleep(1000 + attempt * 500);
      } else {
        return { success: false, error: err.message };
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 *  Task Executor
 * ──────────────────────────────────────────────────────────────── */

async function executeTask(task, tabId) {
  switch (task.type) {
    case 'NAVIGATE': {
      logToPopup('info', `Navigating to page…`);
      setStatus('Navigating…');
      await chrome.tabs.update(tabId, { url: task.url });
      await waitForTabComplete(tabId);
      await humanSleep(TAB_LOAD_BUFFER_MIN, TAB_LOAD_BUFFER_MAX - TAB_LOAD_BUFFER_MIN);
      break;
    }

    case 'JOIN_COMMUNITY': {
      logToPopup('info', `Attempting to join community…`);
      setStatus('Clicking Join button…');

      const resp = await sendToTab(tabId, { action: 'JOIN_COMMUNITY' });

      if (resp?.success) {
        state.stats.joined += 1;
        logToPopup('success', `✅ Joined community. (Total: ${state.stats.joined})`);
      } else {
        logToPopup('warn', `⚠️ Join failed: ${resp?.error || 'No response from tab'}`);
      }

      await persistState({ stats: state.stats });
      updatePopupStats();
      break;
    }

    case 'POST_MESSAGE': {
      logToPopup('info', `Posting message in community…`);
      setStatus('Typing post content…');

      const resp = await sendToTab(tabId, {
        action: 'POST_MESSAGE',
        content: task.content,
      });

      if (resp?.success) {
        state.stats.posted += 1;
        logToPopup('success', `✅ Post published. (Total: ${state.stats.posted})`);
      } else {
        logToPopup('warn', `⚠️ Post failed: ${resp?.error || 'No response from tab'}`);
      }

      await persistState({ stats: state.stats });
      updatePopupStats();
      break;
    }

    case 'FOLLOW_BACK': {
      // Enforce daily cap
      if (state.dailyFollows >= DAILY_FOLLOW_LIMIT) {
        logToPopup('warn', `⚠️ Daily follow cap (${DAILY_FOLLOW_LIMIT}) reached. Skipping.`);
        return;
      }

      const batchSize = Math.min(
        task.maxFollows || MICRO_BATCH_SIZE,
        DAILY_FOLLOW_LIMIT - state.dailyFollows
      );

      logToPopup('info', `Following up to ${batchSize} accounts (daily: ${state.dailyFollows}/${DAILY_FOLLOW_LIMIT})…`);
      setStatus(`Following ${batchSize} account(s)…`);

      const resp = await sendToTab(tabId, {
        action: 'FOLLOW_BACK',
        maxFollows: batchSize,
      });

      if (resp?.success && resp.followed) {
        state.dailyFollows += resp.followed;
        state.stats.followed += resp.followed;
        logToPopup('success', `✅ Followed ${resp.followed} account(s). (Daily: ${state.dailyFollows}/${DAILY_FOLLOW_LIMIT})`);
      } else {
        logToPopup('warn', `⚠️ Follow batch: ${resp?.error || 'No accounts followed.'}`);
      }

      await persistState({
        stats: state.stats,
        dailyFollows: state.dailyFollows,
        lastResetDate: state.lastResetDate,
      });
      updatePopupStats();
      break;
    }

    default:
      logToPopup('error', `Unknown task type: ${task.type}`);
  }
}

/* ────────────────────────────────────────────────────────────────
 *  Main Workflow Runner
 * ──────────────────────────────────────────────────────────────── */

async function runWorkflow() {
  if (state.queue.length === 0) {
    logToPopup('warn', 'Queue is empty. Nothing to do.');
    setStatus('Idle — queue empty');
    state.running = false;
    await persistState({ running: false });
    updatePopupStats();
    return;
  }

  state.running = true;
  await persistState({ running: true });
  updatePopupStats();
  setStatus('Starting workflow…');
  logToPopup('info', `🚀 Workflow started. ${state.queue.length} tasks queued.`);

  // Create dedicated automation tab
  let tabId = await ensureTab(null);

  for (let i = 0; i < state.queue.length && state.running; i++) {
    const task = state.queue[i];

    logToPopup(
      'muted',
      `[${i + 1}/${state.queue.length}] Processing: ${task.type}${task.url ? ' → ' + task.url.slice(0, 60) : ''}`
    );
    setStatus(`Task ${i + 1} of ${state.queue.length}: ${formatTaskType(task.type)}…`);

    // Ensure the tab is still alive before each task
    tabId = await ensureTab(tabId);

    // For non-navigate tasks, let the page settle before acting
    if (task.type !== 'NAVIGATE') {
      await humanSleep(TAB_LOAD_BUFFER_MIN, TAB_LOAD_BUFFER_MAX - TAB_LOAD_BUFFER_MIN);
    }

    // Execute the task
    await executeTask(task, tabId);

    // ---- ANTI-SUSPENSION: Long pause between major tasks ----
    if (i < state.queue.length - 1 && state.running) {
      const pauseMs =
        TASK_INTERVAL_MIN +
        Math.floor(Math.random() * (TASK_INTERVAL_MAX - TASK_INTERVAL_MIN));
      const totalSeconds = Math.round(pauseMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;

      logToPopup('muted', `💤 Sleeping ${minutes}m ${seconds}s before next action…`);
      setStatus(`Sleeping ${minutes}m ${seconds}s before next action…`);

      await sleep(pauseMs);
    }
  }

  // Workflow complete
  state.running = false;
  await persistState({ running: false });
  updatePopupStats();

  // Close the automation tab gracefully
  try {
    await chrome.tabs.remove(tabId);
  } catch {}

  logToPopup(
    'success',
    `✅ Workflow complete! Joined: ${state.stats.joined} | Posted: ${state.stats.posted} | Followed: ${state.stats.followed}`
  );
  setStatus('Completed');
}

function formatTaskType(type) {
  switch (type) {
    case 'NAVIGATE':
      return 'Navigating';
    case 'JOIN_COMMUNITY':
      return 'Joining community';
    case 'POST_MESSAGE':
      return 'Posting';
    case 'FOLLOW_BACK':
      return 'Following accounts';
    default:
      return type;
  }
}

/* ────────────────────────────────────────────────────────────────
 *  Sleep helpers
 * ──────────────────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Human-like sleep with random variance.
 * @param {number} baseMs
 * @param {number} varianceMs
 */
function humanSleep(baseMs, varianceMs) {
  const delay = baseMs + Math.floor(Math.random() * varianceMs);
  return new Promise((r) => setTimeout(r, delay));
}

/* ────────────────────────────────────────────────────────────────
 *  Message Handler — from popup.js
 * ──────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      switch (request.type) {
        case 'INJECT_TOKEN': {
          logToPopup('info', 'Injecting auth token…');
          setStatus('Injecting auth token…');
          const result = await injectAuthToken(request.token);
          sendResponse(result);
          return;
        }

        case 'START_WORKFLOW': {
          if (state.running) {
            sendResponse({ success: false, error: 'Workflow is already running.' });
            return;
          }

          const urls = (request.communityUrls || '')
            .split('\n')
            .map((u) => u.trim())
            .filter((u) => u.length > 0);

          if (urls.length === 0 && !request.autoFollow) {
            sendResponse({
              success: false,
              error: 'No community URLs provided and auto-follow is disabled.',
            });
            return;
          }

          state.queue = buildQueue(urls, request.postContent || '', request.autoFollow || false);

          if (state.queue.length === 0) {
            sendResponse({ success: false, error: 'No tasks could be built from your inputs.' });
            return;
          }

          // Reset stats for a fresh run
          state.stats = { joined: 0, posted: 0, followed: 0 };
          await persistState({ stats: state.stats, queue: state.queue });

          // Fire-and-forget the workflow (continues running after sendResponse)
          runWorkflow();

          sendResponse({ success: true, taskCount: state.queue.length });
          return;
        }

        case 'STOP_WORKFLOW': {
          state.running = false;
          await persistState({ running: false });
          logToPopup('warn', '🛑 Workflow stopped by user.');
          setStatus('Stopped');
          updatePopupStats();
          sendResponse({ success: true });
          return;
        }

        case 'GET_STATE': {
          sendResponse({
            running: state.running,
            stats: state.stats,
            dailyFollows: state.dailyFollows,
            dailyLimit: DAILY_FOLLOW_LIMIT,
            queueLength: state.queue.length,
          });
          return;
        }

        case 'CLEAR_STATS': {
          state.stats = { joined: 0, posted: 0, followed: 0 };
          state.dailyFollows = 0;
          await persistState({
            stats: state.stats,
            dailyFollows: 0,
            lastResetDate: new Date().toISOString().slice(0, 10),
          });
          updatePopupStats();
          sendResponse({ success: true });
          return;
        }

        default:
          sendResponse({ success: false, error: `Unknown type: ${request.type}` });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep the messaging channel open for async responses
});

/* ────────────────────────────────────────────────────────────────
 *  Initialisation
 * ──────────────────────────────────────────────────────────────── */

loadState().then(() => {
  console.log('[Xpert Engage] background.js initialised.');
  logToPopup('info', 'Background service worker ready.');
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logToPopup('info', 'Thanks for installing Xpert Engage! Open the popup to get started.');
  }
});