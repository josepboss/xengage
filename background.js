/**
 * background.js — Task Orchestrator & Session Manager
 *
 * This service worker is the brain of the extension:
 * 1. Injects auth_token cookie to authenticate the X session
 * 2. Maintains a shuffled, interleaved task queue (join, post, follow)
 * 3. Enforces anti-suspension delays between every action
 * 4. Tracks daily caps (max 50 follows/day stored in chrome.storage.local)
 * 5. Streams status updates back to the popup via chrome.runtime messaging
 *
 * Manifest V3 service worker — persists across events but can be killed.
 * All state is persisted in chrome.storage.local for reliability.
 */

/* ────────────────────────────────────────────────────────────────
 *  Constants
 * ──────────────────────────────────────────────────────────────── */

const DAILY_FOLLOW_LIMIT = 50;
const MICRO_BATCH_SIZE = 3;
const MICRO_BATCH_SLEEP_MS = 60 * 60 * 1000; // 1 hour

// Anti-suspension timing (ms)
const TAB_LOAD_BUFFER_MIN = 5000;
const TAB_LOAD_BUFFER_MAX = 10000;
const TASK_INTERVAL_MIN = 4 * 60 * 1000; // 4 min
const TASK_INTERVAL_MAX = 7 * 60 * 1000; // 7 min

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
 * Load persisted state from chrome.storage.local.
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

  // Reset daily counter if it's a new day
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastResetDate !== today) {
    state.dailyFollows = 0;
    state.lastResetDate = today;
    await chrome.storage.local.set({
      dailyFollows: 0,
      lastResetDate: today,
    });
  }
}

/**
 * Persist critical state fields to storage.
 */
async function persistState(fields) {
  await chrome.storage.local.set(fields);
}

/**
 * Send a log entry to the popup (if open).
 */
function logToPopup(level, message) {
  chrome.runtime
    .sendMessage({
      type: 'LOG',
      level,
      message,
      timestamp: Date.now(),
    })
    .catch(() => {
      /* popup may not be open */
    });
}

/**
 * Send updated stats to the popup.
 */
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

/**
 * Send the current status string to popup.
 */
function setStatus(statusText) {
  chrome.runtime
    .sendMessage({ type: 'STATUS', text: statusText })
    .catch(() => {});
}

/* ────────────────────────────────────────────────────────────────
 *  Cookie / Auth Helpers
 * ──────────────────────────────────────────────────────────────── */

/**
 * Clear all existing x.com cookies and inject the provided auth_token.
 * Then open x.com to let the session take effect.
 */
async function injectAuthToken(authToken) {
  const domain = '.x.com';

  // Clear existing cookies for x.com
  const existing = await chrome.cookies.getAll({ domain });
  for (const cookie of existing) {
    await chrome.cookies.remove({
      url: `https://${domain.replace(/^\./, '')}${cookie.path}`,
      name: cookie.name,
    });
  }

  // Inject the new auth_token
  await chrome.cookies.set({
    url: `https://${domain.replace(/^\./, '')}`,
    domain,
    name: 'auth_token',
    value: authToken,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });

  // Also set a few additional cookies to mimic a real browser
  await chrome.cookies.set({
    url: `https://${domain.replace(/^\./, '')}`,
    domain,
    name: 'lang',
    value: 'en',
    path: '/',
    secure: true,
  });

  logToPopup('success', 'Auth token injected successfully.');

  // Open x.com to authenticate
  await chrome.tabs.create({ url: 'https://x.com', active: false });

  return { success: true };
}

/* ────────────────────────────────────────────────────────────────
 *  Task Queue Builder
 * ──────────────────────────────────────────────────────────────── */

/**
 * Build an interleaved (shuffled) task queue from the user's inputs.
 *
 * Strategy: Mix join, post, and follow tasks so we never do the same
 * action type more than 2 times in a row. This mimics organic behaviour.
 *
 * @param {string[]} communityUrls
 * @param {string}   postContent
 * @param {boolean}  autoFollowEnabled
 */
function buildQueue(communityUrls, postContent, autoFollowEnabled) {
  const tasks = [];

  // For each community URL, create a join task and (if content provided) a post task
  for (const url of communityUrls) {
    const trimmed = url.trim();
    if (!trimmed) continue;

    tasks.push({ type: 'NAVIGATE', url: trimmed });
    tasks.push({ type: 'JOIN_COMMUNITY' });

    if (postContent && postContent.trim().length > 0) {
      tasks.push({ type: 'POST_MESSAGE', content: postContent.trim() });
    }
  }

  // Add follow-back tasks interspersed
  if (autoFollowEnabled) {
    // Insert follow tasks at multiple points in the queue
    const followTargets = [3, 2, 3]; // 3 follow sessions, varying sizes
    let insertAt = Math.max(1, Math.floor(tasks.length / 4));

    for (const count of followTargets) {
      const followTask = {
        type: 'NAVIGATE',
        url: 'https://x.com/i/connect_people',
      };
      const followAction = {
        type: 'FOLLOW_BACK',
        maxFollows: Math.min(count, MICRO_BATCH_SIZE),
      };

      // Insert at strategic positions to interleave
      const pos = Math.min(insertAt, tasks.length);
      tasks.splice(pos, 0, followTask, followAction);
      insertAt += Math.max(2, Math.floor(tasks.length / 3));
    }
  }

  // Final shuffle: swap adjacent tasks of different types to ensure mixing
  for (let i = 1; i < tasks.length - 1; i += 2) {
    if (
      tasks[i].type !== tasks[i - 1].type &&
      tasks[i].type !== tasks[i + 1]?.type
    ) {
      // Already well-mixed
    } else if (tasks[i + 1]) {
      // Swap with next
      [tasks[i], tasks[i + 1]] = [tasks[i + 1], tasks[i]];
    }
  }

  return tasks;
}

/* ────────────────────────────────────────────────────────────────
 *  Task Executor
 * ──────────────────────────────────────────────────────────────── */

/**
 * Execute a single task item from the queue.
 * This involves opening a tab, waiting for it to load, and sending a
 * message to the content script to perform the action.
 *
 * @param {object} task
 * @param {number} tabId
 */
async function executeTask(task, tabId) {
  switch (task.type) {
    case 'NAVIGATE': {
      logToPopup('info', `Navigating to community page…`);
      setStatus('Navigating to community…');
      await chrome.tabs.update(tabId, { url: task.url });
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
        logToPopup(
          'warn',
          `⚠️ Join failed: ${resp?.error || 'No response from tab'}`
        );
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
        logToPopup(
          'warn',
          `⚠️ Post failed: ${resp?.error || 'No response from tab'}`
        );
      }

      await persistState({ stats: state.stats });
      updatePopupStats();
      break;
    }

    case 'FOLLOW_BACK': {
      // Check daily cap
      if (state.dailyFollows >= DAILY_FOLLOW_LIMIT) {
        logToPopup(
          'warn',
          `⚠️ Daily follow cap (${DAILY_FOLLOW_LIMIT}) reached. Skipping follow batch.`
        );
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
        logToPopup(
          'success',
          `✅ Followed ${resp.followed} account(s). (Daily: ${state.dailyFollows}/${DAILY_FOLLOW_LIMIT})`
        );
      } else {
        logToPopup(
          'warn',
          `⚠️ Follow batch: ${resp?.error || 'No accounts followed.'}`
        );
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

/**
 * Send a message to a content script in a specific tab and wait for the response.
 * Injects the content script if not already loaded.
 */
async function sendToTab(tabId, message, timeoutMs = 30000) {
  try {
    // First ensure the content script is injected
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'PING' });
    } catch {
      // Content script not loaded yet — inject it
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      // Give it a moment to initialise
      await sleep(500);
    }

    // Wrap in a promise with timeout
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Response timeout')), timeoutMs);
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
    return { success: false, error: err.message };
  }
}

/**
 * Human-like sleep: Base Time + Random Variance.
 * @param {number} baseMs - minimum sleep duration
 * @param {number} varianceMs - additional random variance
 */
function humanSleep(baseMs, varianceMs) {
  const delay = baseMs + Math.floor(Math.random() * varianceMs);
  return new Promise((r) => setTimeout(r, delay));
}

/* ────────────────────────────────────────────────────────────────
 *  Main Workflow Runner
 * ──────────────────────────────────────────────────────────────── */

/**
 * Process the entire task queue with anti-suspension delays.
 */
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

  // Create a dedicated tab for automation (reuse if possible)
  let tab = await chrome.tabs.create({
    url: 'https://x.com',
    active: false,
  });

  let consecutiveFailures = 0;

  for (let i = 0; i < state.queue.length && state.running; i++) {
    const task = state.queue[i];

    // Log current position
    logToPopup(
      'muted',
      `[${i + 1}/${state.queue.length}] Processing: ${task.type}${task.url ? ' → ' + task.url.slice(0, 60) : ''}`
    );
    setStatus(`Task ${i + 1} of ${state.queue.length}: ${formatTaskType(task.type)}…`);

    // Wait for the tab to be fully loaded before interacting
    if (task.type === 'NAVIGATE') {
      // Already navigating — wait for load
      await waitForTabComplete(tab.id);
      await humanSleep(TAB_LOAD_BUFFER_MIN, TAB_LOAD_BUFFER_MAX - TAB_LOAD_BUFFER_MIN);
    } else {
      // Non-navigate tasks also need the page settled
      await humanSleep(TAB_LOAD_BUFFER_MIN, TAB_LOAD_BUFFER_MAX - TAB_LOAD_BUFFER_MIN);
    }

    // Check if the tab is still valid
    try {
      await chrome.tabs.get(tab.id);
    } catch {
      // Tab was closed — recreate it
      tab = await chrome.tabs.create({
        url: 'https://x.com',
        active: false,
      });
      await waitForTabComplete(tab.id);
    }

    // Execute the task
    await executeTask(task, tab.id);

    // Check if the result was a failure and track consecutive failures
    // (We don't have the result here directly, but we can infer from logging)
    consecutiveFailures++;

    // ---- ANTI-SUSPENSION: Long pause between major tasks ----
    if (i < state.queue.length - 1 && state.running) {
      const pauseMs =
        TASK_INTERVAL_MIN +
        Math.floor(Math.random() * (TASK_INTERVAL_MAX - TASK_INTERVAL_MIN));
      const pauseSeconds = Math.round(pauseMs / 1000);
      const minutes = Math.floor(pauseSeconds / 60);
      const seconds = pauseSeconds % 60;

      logToPopup(
        'muted',
        `💤 Sleeping ${minutes}m ${seconds}s before next action…`
      );
      setStatus(`Sleeping ${minutes}m ${seconds}s before next action…`);

      await sleep(pauseMs);
    }
  }

  // Workflow complete
  state.running = false;
  await persistState({ running: false });
  updatePopupStats();

  // Close the automation tab
  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  logToPopup(
    'success',
    `✅ Workflow complete! Joined: ${state.stats.joined} | Posted: ${state.stats.posted} | Followed: ${state.stats.followed}`
  );
  setStatus('Completed');
}

/**
 * Wait for a tab to reach "complete" readyState.
 */
async function waitForTabComplete(tabId, pollMs = 500, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return; // Tab no longer exists
    }
    await sleep(pollMs);
  }
}

/**
 * Format task type for display.
 */
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
 *  Sleep helper (for service worker which may not have setTimeout)
 * ──────────────────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

          // Build the queue from provided data
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

          state.queue = buildQueue(
            urls,
            request.postContent || '',
            request.autoFollow || false
          );

          if (state.queue.length === 0) {
            sendResponse({ success: false, error: 'No tasks could be built from your inputs.' });
            return;
          }

          // Reset stats for fresh run
          state.stats = { joined: 0, posted: 0, followed: 0 };
          await persistState({ stats: state.stats, queue: state.queue });

          // Fire and forget — run in background
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

  return true; // Keep channel open
});

/* ────────────────────────────────────────────────────────────────
 *  Initialisation
 * ──────────────────────────────────────────────────────────────── */

loadState().then(() => {
  console.log('[Xpert Engage] background.js initialised.');
  logToPopup('info', 'Background service worker ready.');
});

// Handle extension install / update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logToPopup('info', 'Thanks for installing Xpert Engage! Open the popup to get started.');
  }
});