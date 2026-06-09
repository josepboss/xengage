/**
 * content.js — X.com DOM Interaction Engine
 *
 * Injected into all x.com pages at document_idle. Exposes a message listener
 * so the background service worker can dispatch commands (join, post, follow)
 * that interact with X's heavy React-rendered UI.
 *
 * All DOM queries use active polling (every 500ms, up to 15s) to handle
 * X's dynamic component mounting. Typing uses document.execCommand('insertText')
 * inside a typewriter loop to properly update React's internal input state.
 *
 * Pattern: waitForElementAndExecute → locate element → human delay → act → respond()
 */

(function () {
  'use strict';

  /* ────────────────────────────────────────────────────────────────
   *  Constants
   * ──────────────────────────────────────────────────────────────── */

  const POLL_INTERVAL_MS = 500;
  const POLL_TIMEOUT_MS = 15000;
  const KEYSTROKE_DELAY_MIN = 50;
  const KEYSTROKE_DELAY_MAX = 150;

  /* ────────────────────────────────────────────────────────────────
   *  Utility Helpers
   * ──────────────────────────────────────────────────────────────── */

  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Active polling: scan the DOM every `pollInterval` ms until the predicate
   * returns a truthy element, or `timeout` ms elapses.
   *
   * @param {() => HTMLElement|null} predicate - synchronous DOM check
   * @param {number} [timeout] - max ms to poll (default 15000)
   * @param {number} [pollInterval] - ms between polls (default 500)
   * @returns {Promise<HTMLElement|null>}
   */
  async function waitForElementAndExecute(predicate, timeout = POLL_TIMEOUT_MS, pollInterval = POLL_INTERVAL_MS) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = predicate();
      if (el) return el;
      await sleep(pollInterval);
    }
    return predicate(); // one last try
  }

  /**
   * Find the closest clickable element for a matched inner node.
   * Searches up the ancestor chain for button / [role="button"] / a.
   */
  function closestClickable(el) {
    if (!el) return null;
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A') return el;
    return el.closest('button, [role="button"], a');
  }

  /**
   * Match textContent (trimmed) against a string, case-insensitive.
   */
  function textMatches(el, target) {
    if (!el || !el.textContent) return false;
    return el.textContent.trim().toLowerCase() === target.toLowerCase();
  }

  /**
   * Poll for an element whose text matches `target` (case-insensitive),
   * scanning across button / [role="button"] / span / div elements.
   * Returns the clickable parent node (via closestClickable) or null.
   */
  async function findButtonByText(target, timeout = POLL_TIMEOUT_MS) {
    return waitForElementAndExecute(() => {
      // Scan all common interactive + text nodes
      const candidates = document.querySelectorAll(
        'button, [role="button"], a, span, div[role="button"]'
      );
      for (const el of candidates) {
        if (textMatches(el, target)) {
          const clickable = closestClickable(el);
          if (clickable && clickable.offsetParent !== null) return clickable;
        }
      }
      return null;
    }, timeout);
  }

  /**
   * Simulate human typing into a contenteditable element using
   * document.execCommand('insertText') in a typewriter loop.
   * This properly triggers X's React input listeners.
   */
  async function simulateTyping(element, text) {
    element.focus();
    await sleep(rand(300, 800));

    // Focus the element by placing a cursor at the end
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false); // collapse to end
    selection.removeAllRanges();
    selection.addRange(range);

    await sleep(rand(200, 400));

    // Clear existing placeholder content safely
    if (element.textContent.trim().length > 0) {
      element.textContent = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(rand(100, 300));
    }

    // Typewriter loop — one character at a time
    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Focus the element before each keystroke to keep React's cursor alive
      element.focus();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(element);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);

      // Use execCommand to insert the character — this triggers X's React state
      document.execCommand('insertText', false, char);

      // Dispatch additional events for stealth / compatibility
      element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));

      // Randomised human-like delay between keystrokes
      await sleep(rand(KEYSTROKE_DELAY_MIN, KEYSTROKE_DELAY_MAX));
    }

    // Final change event so any remaining listeners pick up completion
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(rand(200, 500));
  }

  /* ────────────────────────────────────────────────────────────────
   *  Core Actions
   * ──────────────────────────────────────────────────────────────── */

  /**
   * JOIN a community on the current page.
   * Actively polls for a clickable element whose textContent matches "join"
   * (case-insensitive) across all button, [role="button"], span nodes.
   * Uses .closest('[role="button"]') to find the actual clickable node.
   */
  async function actionJoinCommunity() {
    // Let page settle after navigation
    await sleep(rand(1500, 3000));

    // Poll for the Join button (up to 15s)
    const joinBtn = await findButtonByText('join', POLL_TIMEOUT_MS);

    if (!joinBtn) {
      return { success: false, error: 'Join button not found after polling.' };
    }

    // Scroll into view with human-like hesitation
    joinBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(600, 1500));

    // Pre-click pause
    await sleep(rand(400, 1200));

    // Click
    joinBtn.click();
    await sleep(rand(2000, 4000));

    // Verify: after clicking, the button text should change to contain
    // "Joined", "Requested", or "Pending"
    const confirmTexts = ['joined', 'requested', 'pending', 'leave'];
    // Re-scan with a shorter timeout
    const postJoin = await waitForElementAndExecute(() => {
      const all = document.querySelectorAll('button, [role="button"], span, div[role="button"]');
      for (const el of all) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (confirmTexts.some((ct) => t.includes(ct))) {
          const clickable = closestClickable(el);
          if (clickable && clickable.offsetParent !== null) return clickable;
        }
      }
      return null;
    }, 5000, 500);

    const confirmed = !!postJoin;

    return {
      success: true,
      message: confirmed
        ? 'Community joined successfully.'
        : 'Join button clicked (confirmation pending).',
    };
  }

  /**
   * POST or REPLY content in a community / tweet on the current page.
   * 1. Find the contenteditable textbox via [contenteditable="true"][role="textbox"]
   * 2. Simulate human typing character-by-character using execCommand
   * 3. Find and click the "Post" or "Reply" button
   */
  async function actionPostMessage({ content }) {
    if (!content || content.trim().length === 0) {
      return { success: false, error: 'No content provided to post.' };
    }

    await sleep(rand(1500, 3000));

    // Poll for the text input element
    const textbox = await waitForElementAndExecute(
      () =>
        document.querySelector(
          '[contenteditable="true"][role="textbox"]'
        ) || document.querySelector('div[contenteditable="true"]'),
      POLL_TIMEOUT_MS
    );

    if (!textbox) {
      return { success: false, error: 'Text input field not found after polling.' };
    }

    // Scroll textbox into view
    textbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(500, 1200));

    // Simulate typing with the typewriter loop
    await simulateTyping(textbox, content);

    // Short pause after typing
    await sleep(rand(800, 2000));

    // Find the confirmation button — "Post" or "Reply"
    let confirmBtn = await findButtonByText('post', 8000);

    if (!confirmBtn) {
      confirmBtn = await findButtonByText('reply', 8000);
    }

    if (!confirmBtn) {
      return {
        success: false,
        error: 'Post/Reply button not found. Text was typed but not submitted.',
      };
    }

    confirmBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(500, 1200));

    // Check if disabled
    if (
      confirmBtn.hasAttribute('disabled') ||
      confirmBtn.getAttribute('aria-disabled') === 'true' ||
      confirmBtn.classList.contains('disabled')
    ) {
      return {
        success: false,
        error: 'Post/Reply button is disabled (content may be empty or invalid).',
      };
    }

    confirmBtn.click();
    await sleep(rand(2000, 4000));

    return { success: true, message: 'Post/Reply submitted successfully.' };
  }

  /**
   * FOLLOW accounts on the current Connect People / followers page.
   * Finds visible "Follow" buttons (excluding "Following", "Follows you", "Pending")
   * and clicks up to `maxFollows` of them with randomised delays.
   */
  async function actionFollowBack({ maxFollows = 3 } = {}) {
    await sleep(rand(2000, 4000));

    // Scroll to trigger lazy loading
    window.scrollBy({ top: rand(300, 800), behavior: 'smooth' });
    await sleep(rand(1000, 2000));

    // Collect all visible Follow buttons
    const followBtns = [];

    await waitForElementAndExecute(() => {
      followBtns.length = 0;
      const candidates = document.querySelectorAll(
        'button, [role="button"]'
      );
      for (const btn of candidates) {
        const text = (btn.textContent || '').trim();
        if (
          text === 'Follow' &&
          !btn.hasAttribute('disabled') &&
          btn.getAttribute('aria-disabled') !== 'true' &&
          btn.offsetParent !== null // visible
        ) {
          followBtns.push(btn);
        }
      }
      return followBtns.length > 0 ? followBtns[0] : null;
    }, 8000);

    if (followBtns.length === 0) {
      return {
        success: false,
        error: 'No visible Follow buttons found on this page.',
      };
    }

    const toClick = followBtns.slice(0, Math.min(maxFollows, followBtns.length));
    let clickedCount = 0;

    for (const btn of toClick) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(800, 2000));

      btn.click();
      clickedCount++;

      // Randomised delay between follows
      await sleep(rand(3000, 6000));
    }

    return {
      success: true,
      message: `Followed ${clickedCount} account(s).`,
      followed: clickedCount,
    };
  }

  /* ────────────────────────────────────────────────────────────────
   *  Message Listener — bridge from background.js
   * ──────────────────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = (async () => {
      try {
        switch (request.action) {
          case 'PING':
            return { success: true, message: 'content.js is alive.' };

          case 'JOIN_COMMUNITY': {
            const result = await actionJoinCommunity();
            return result;
          }

          case 'POST_MESSAGE': {
            const result = await actionPostMessage({
              content: request.content,
            });
            return result;
          }

          case 'FOLLOW_BACK': {
            const result = await actionFollowBack({
              maxFollows: request.maxFollows || 3,
            });
            return result;
          }

          default:
            return { success: false, error: `Unknown action: ${request.action}` };
        }
      } catch (err) {
        return { success: false, error: err.message || String(err) };
      }
    })();

    handler.then(sendResponse);
    return true; // Keep channel open for async response
  });

  console.log('[Xpert Engage] content.js injected and ready.');
})();