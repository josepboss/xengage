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
 * Join matching uses a 4-phase fallback strategy:
 *   1. Broad text-Contains scan via findButtonByText
 *   2. Scroll + retry (some X layouts mount buttons after scroll)
 *   3. Leaf-node scan over ALL elements for "Join" text
 *   4. Always uses .closest to find the clickable parent for nested spans
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
   * Check if an element's visible text content contains `target`
   * (case-insensitive, partial match). Uses includes() rather than
   * strict equality to handle extra whitespace, hidden child nodes,
   * and zero-width characters that X.com often injects.
   */
  function textContains(el, target) {
    if (!el || !el.textContent) return false;
    const text = el.textContent.trim().toLowerCase();
    return text.includes(target.toLowerCase());
  }

  /**
   * Check if an element is actually visible on screen.
   * Uses offsetParent (fastest) and falls back to checking
   * clientRects for edge cases.
   */
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    // offsetParent can be null for some positioned elements that are still visible
    return el.getClientRects().length > 0 &&
           (el.clientWidth > 0 || el.clientHeight > 0);
  }

  /**
   * Find the closest clickable ancestor for a matched inner node.
   * Searches up the ancestor chain. If the element itself is already
   * clickable (button / [role="button"] / a), returns it directly.
   */
  function closestClickable(el) {
    if (!el) return null;
    const clickableTags = 'button, [role="button"], a, div[role="button"]';
    if (el.matches && el.matches(clickableTags)) return el;
    return el.closest(clickableTags);
  }

  /**
   * Poll for a clickable element whose visible text contains `target`
   * (case-insensitive, partial match). Scans across all common
   * interactive and text-level elements every 500ms for up to `timeout` ms.
   *
   * Returns the clickable parent node (via closestClickable) or null.
   */
  async function findButtonByText(target, timeout = POLL_TIMEOUT_MS) {
    return waitForElementAndExecute(() => {
      const candidates = document.querySelectorAll(
        'button, [role="button"], a, span, div, label'
      );
      for (const el of candidates) {
        if (!textContains(el, target)) continue;
        const clickable = closestClickable(el);
        if (clickable && isVisible(clickable)) return clickable;
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
   *
   * Multi-phase strategy:
   *   1. Let page settle (1.5–3s random)
   *   2. Poll for "Join" button via findButtonByText (up to 15s, every 500ms)
   *      - Uses textContains (partial match, case-insensitive)
   *      - Uses closestClickable for nested span layouts
   *   3. If not found, scroll down slightly and retry (some X layouts
   *      only mount the button after a scroll-triggered React render)
   *   4. If still not found, scan ALL leaf-level DOM elements for
   *      exact "join" text as a last resort
   *   5. Dispatch mousedown→mouseup→click sequence for React reliability
   *   6. Verify by polling for confirmation text ("Joined", "Requested", "Pending")
   */
  async function actionJoinCommunity() {
    // Phase 1: Let page settle after navigation
    await sleep(rand(1500, 3000));

    // Phase 2: Poll for the Join button (broad textContains, up to 15s)
    let joinBtn = await findButtonByText('join', POLL_TIMEOUT_MS);

    // Phase 3: Fallback — scroll to trigger lazy React rendering, then retry
    if (!joinBtn) {
      window.scrollBy({ top: rand(100, 400), behavior: 'smooth' });
      await sleep(rand(1000, 2000));
      joinBtn = await findButtonByText('join', 8000);
    }

    // Phase 4: Last resort — scan ALL leaf elements for exact/trimmed "Join" text
    if (!joinBtn) {
      joinBtn = await waitForElementAndExecute(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          // Only consider leaf nodes (elements with no children or whose
          // textContent is not just whitespace from children)
          const text = (el.textContent || '').trim();
          if (text.length === 0) continue;
          if (el.children.length > 0 && Array.from(el.children).some(c => c.textContent.trim())) continue;

          const lower = text.toLowerCase();
          if (lower === 'join' || lower.startsWith('join') || lower === 'join ') {
            if (!isVisible(el)) continue;
            const clickable = closestClickable(el) || el;
            if (clickable && !clickable.hasAttribute('disabled')) return clickable;
          }
        }
        return null;
      }, 5000);
    }

    if (!joinBtn) {
      return { success: false, error: 'Join button not found after exhaustive polling.' };
    }

    // Scroll into view with human-like hesitation
    joinBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(600, 1500));
    await sleep(rand(400, 1200));

    // Simulate a real click series (mousedown → mouseup → click)
    // X's React often responds more reliably to this sequence
    joinBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    await sleep(rand(50, 150));
    joinBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    await sleep(rand(50, 150));
    joinBtn.click();

    await sleep(rand(2000, 4000));

    // Phase 6: Verify — poll for confirmation text
    const confirmTexts = ['joined', 'requested', 'pending', 'leave'];
    const postJoin = await waitForElementAndExecute(() => {
      const all = document.querySelectorAll('button, [role="button"], span, div');
      for (const el of all) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (confirmTexts.some((ct) => t.includes(ct)) && isVisible(el)) {
          const clickable = closestClickable(el);
          if (clickable && isVisible(clickable)) return clickable;
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
          isVisible(btn)
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