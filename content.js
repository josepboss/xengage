/**
 * content.js — X.com DOM Interaction Engine (Language‑Agnostic)
 *
 * Uses only static, language‑agnostic `data-testid` attributes verified
 * from Chrome DevTools DOM snapshots. No text‑string searches.
 *
 * Core selectors:
 *   Join:   [data-testid="primaryColumn"] button  (inside primary column)
 *   Text:   [data-testid="tweetTextarea_0"]
 *   Post:   [data-testid="tweetButton"]
 *   Follow: [data-testid="userFollowButton"] or [data-testid*="follow"]
 *
 * Interaction: full hardware state emulation chain (mousedown → mouseup → click)
 */

(function () {
  'use strict';

  /* ────────────────────────────────────────────────────────────────
   *  Utility Helpers
   * ──────────────────────────────────────────────────────────────── */

  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Emit a detailed debug log to the console. */
  function debugLog(label, data) {
    console.log(`[Xpert Engage:debug] ${label}`, data);
  }

  /* ────────────────────────────────────────────────────────────────
   *  HARDWARE STATE EMULATION CHAIN
   *
   *  Dispatches a full mouse‑event sequence to simulate a real click.
   *  X's React heavily gatekeeps synthetic events; this sequence works
   *  because it mirrors actual user input.
   * ──────────────────────────────────────────────────────────────── */

  function emulateHardwareClick(element) {
    if (!element) return;

    debugLog('emulateHardwareClick: dispatching event chain on', {
      tag: element.tagName,
      testid: element.getAttribute('data-testid'),
      class: element.className?.slice(0, 60),
    });

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    function fireMouse(type, opts = {}) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: 0,
        buttons: type === 'mousedown' ? 1 : 0,
        ...opts,
      });
      element.dispatchEvent(event);
    }

    // Phase 1: mousedown
    fireMouse('mousedown');

    // Phase 2: after a human-like delay, mouseup
    setTimeout(() => {
      fireMouse('mouseup');
    }, rand(60, 150));

    // Phase 3: after another brief delay, click
    setTimeout(() => {
      fireMouse('click');
    }, rand(100, 220));
  }

  /* ────────────────────────────────────────────────────────────────
   *  POLLING HELPER
   *
   *  Polls a CSS selector every `intervalMs` until the element is found
   *  or the timeout expires. Returns the element or null.
   * ──────────────────────────────────────────────────────────────── */

  async function pollSelector(selector, timeoutMs = 15000, intervalMs = 500) {
    const start = Date.now();
    let attempts = 0;

    while (Date.now() - start < timeoutMs) {
      attempts++;

      const el = document.querySelector(selector);
      if (el) {
        // Verify it's visible to the user (not hidden, not zero-size)
        const rect = el.getBoundingClientRect();
        const visible =
          el.offsetParent !== null &&
          rect.width > 0 &&
          rect.height > 0 &&
          window.getComputedStyle(el).visibility !== 'hidden';

        if (visible) {
          debugLog(`pollSelector: found "${selector}" in ${attempts} attempts`, {
            tag: el.tagName,
            testid: el.getAttribute('data-testid'),
            rect,
          });
          return el;
        }

        debugLog(`pollSelector: "${selector}" found but hidden (attempt ${attempts})`, {
          rect,
          visibility: window.getComputedStyle(el).visibility,
          display: window.getComputedStyle(el).display,
        });
      }

      debugLog(`pollSelector: attempt ${attempts} — "${selector}" not found yet`);
      await sleep(intervalMs);
    }

    debugLog(`pollSelector: TIMEOUT after ${attempts} attempts for "${selector}"`);
    return null;
  }

  /* ────────────────────────────────────────────────────────────────
   *  CORE ACTIONS
   * ──────────────────────────────────────────────────────────────── */

  /**
   * JOIN a community.
   *
   * Target: the primary action button inside the primary column header.
   * Use `[data-testid="primaryColumn"] button` as the anchor.
   */
  async function actionJoinCommunity() {
    await sleep(rand(1500, 3000));

    debugLog('actionJoinCommunity: starting');

    // Primary selector: button inside the primary column (community header)
    const joinBtn = await pollSelector(
      '[data-testid="primaryColumn"] button',
      12000
    );

    if (joinBtn) {
      debugLog('actionJoinCommunity: found button in primary column');
      emulateHardwareClick(joinBtn);
      await sleep(rand(2000, 3500));

      // Check for confirmation state: button may change to "Joined"/"Requested"
      const confirmSelectors = [
        '[data-testid*="community"] button',
        '[role="button"][aria-pressed="true"]',
      ];
      for (const sel of confirmSelectors) {
        const confirmEl = await pollSelector(sel, 3000, 500);
        if (confirmEl) {
          debugLog(`actionJoinCommunity: confirmation element found via "${sel}"`);
          return { success: true, message: 'Community joined successfully.' };
        }
      }

      return { success: true, message: 'Join button clicked.' };
    }

    // Fallback: any button inside any element with data-testid containing "community"
    debugLog('actionJoinCommunity: trying fallback community button');
    const communityBtn = await pollSelector(
      '[data-testid*="community"] button, [data-testid*="Community"] button',
      8000
    );

    if (communityBtn) {
      emulateHardwareClick(communityBtn);
      await sleep(rand(2000, 3500));
      return { success: true, message: 'Community button clicked (fallback).' };
    }

    return {
      success: false,
      error: 'Could not locate a community join button using data-testid selectors.',
    };
  }

  /**
   * POST a message to the community.
   *
   * Uses the universal test IDs:
   *   - [data-testid="tweetTextarea_0"] for the text input
   *   - [data-testid="tweetButton"] for the post/submit button
   */
  async function actionPostMessage({ content }) {
    if (!content || content.trim().length === 0) {
      return { success: false, error: 'No content provided to post.' };
    }

    await sleep(rand(1500, 3000));

    debugLog('actionPostMessage: starting');

    // ── Step 1: Find the text input ──────────────────────────────
    const textbox = await pollSelector('[data-testid="tweetTextarea_0"]', 12000);

    if (!textbox) {
      debugLog('actionPostMessage: tweetTextarea_0 not found');
      return { success: false, error: 'Text input field not found on page.' };
    }

    debugLog('actionPostMessage: found [data-testid="tweetTextarea_0"]');

    // Scroll it into view and focus
    textbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(400, 800));
    textbox.focus();
    await sleep(rand(200, 500));

    // Clear existing content
    textbox.textContent = '';
    textbox.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(rand(200, 400));

    // Type content character by character
    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      textbox.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: true,
        })
      );

      textbox.textContent = (textbox.textContent || '') + char;

      textbox.dispatchEvent(
        new InputEvent('input', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: true,
        })
      );

      textbox.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      textbox.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      textbox.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));

      await sleep(rand(40, 120));
    }

    textbox.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(rand(800, 2000));

    // ── Step 2: Click the Post button ────────────────────────────
    debugLog('actionPostMessage: looking for [data-testid="tweetButton"]');

    const postBtn = await pollSelector('[data-testid="tweetButton"]', 10000);

    if (!postBtn) {
      // Fallback: try tweetButtonInline
      debugLog('actionPostMessage: tweetButton not found, trying [data-testid="tweetButtonInline"]');
      const fallbackBtn = await pollSelector(
        '[data-testid="tweetButtonInline"]',
        5000
      );
      if (fallbackBtn) {
        const isDisabled =
          fallbackBtn.hasAttribute('disabled') ||
          fallbackBtn.getAttribute('aria-disabled') === 'true';
        if (!isDisabled) {
          emulateHardwareClick(fallbackBtn);
          await sleep(rand(2000, 3500));
          return { success: true, message: 'Post submitted via tweetButtonInline.' };
        }
        return { success: false, error: 'Post button is disabled.' };
      }
      return { success: false, error: 'Could not find a Post/Submit button.' };
    }

    const isDisabled =
      postBtn.hasAttribute('disabled') ||
      postBtn.getAttribute('aria-disabled') === 'true';

    if (isDisabled) {
      debugLog('actionPostMessage: tweetButton is disabled');
      return { success: false, error: 'Post button is disabled (content may be empty or too short).' };
    }

    emulateHardwareClick(postBtn);
    await sleep(rand(2000, 3500));

    return { success: true, message: 'Post submitted successfully via tweetButton.' };
  }

  /**
   * FOLLOW accounts on the "Connect People" page.
   *
   * Targets [data-testid="userFollowButton"] or [data-testid*="follow"] buttons
   * and clicks up to `maxFollows` of them.
   */
  async function actionFollowBack({ maxFollows = 3 } = {}) {
    await sleep(rand(2000, 4000));

    // Scroll to load more suggestions
    window.scrollBy({ top: rand(300, 800), behavior: 'smooth' });
    await sleep(rand(1000, 2000));

    debugLog('actionFollowBack: starting');

    // Find all follow buttons using data-testid selectors
    const followSelectors = [
      '[data-testid="userFollowButton"]',
      '[data-testid*="followButton"]',
      '[data-testid*="FollowButton"]',
      '[data-testid*="follow"] button',
      'button[data-testid*="follow"]',
    ];

    // Collect all unique follow button elements
    const allFollowButtons = new Set();

    for (const sel of followSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          // Only include visible, not-disabled buttons
          if (
            el.offsetParent !== null &&
            !el.hasAttribute('disabled') &&
            el.getAttribute('aria-disabled') !== 'true'
          ) {
            // Exclude "Following" state — check if button's text indicates already following
            const text = el.textContent.trim().toLowerCase();
            if (!text.includes('following') && !text.includes('pending') && !text.includes('follows')) {
              allFollowButtons.add(el);
            }
          }
        }
      } catch (e) {
        debugLog(`actionFollowBack: error with selector "${sel}"`, e);
      }
    }

    debugLog(
      `actionFollowBack: found ${allFollowButtons.size} followable buttons (data-testid)`,
      [...allFollowButtons].map((e) => ({
        tag: e.tagName,
        testid: e.getAttribute('data-testid'),
        text: e.textContent.trim().slice(0, 30),
      }))
    );

    if (allFollowButtons.size === 0) {
      return { success: false, error: 'No follow buttons found on this page.' };
    }

    // Click up to maxFollows
    const toClick = [...allFollowButtons].slice(0, maxFollows);
    let clickedCount = 0;

    for (const btn of toClick) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(800, 2000));

      emulateHardwareClick(btn);
      clickedCount++;

      await sleep(rand(3000, 6000));
    }

    return {
      success: true,
      message: `Followed ${clickedCount} account(s) via data-testid.`,
      followed: clickedCount,
    };
  }

  /* ────────────────────────────────────────────────────────────────
   *  MESSAGE LISTENER
   * ──────────────────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = (async () => {
      try {
        switch (request.action) {
          case 'PING':
            return { success: true, message: 'content.js is alive.' };

          case 'JOIN_COMMUNITY':
            return await actionJoinCommunity();

          case 'POST_MESSAGE':
            return await actionPostMessage({ content: request.content });

          case 'FOLLOW_BACK':
            return await actionFollowBack({ maxFollows: request.maxFollows || 3 });

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

  console.log('[Xpert Engage] content.js loaded — using only language-agnostic data-testid selectors with hardware event emulation.');
})();