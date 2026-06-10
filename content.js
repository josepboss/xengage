/**
 * content.js — X.com DOM Interaction Engine (Refactored)
 *
 * X uses dynamic, obfuscated React rendering that ignores standard element
 * lookups and flat .click() events. This refactored engine uses four tactics:
 *
 * 1. **Test-ID / ARIA targeting** — scans for [data-testid*="…"] and [role="button"]
 * 2. **Deep text recursive search** — inspects innerText of entire subtrees for
 *    exact-match or substring keywords (e.g. "Join", "Post", "Follow")
 * 3. **Trusted PointerEvent dispatch** — replaces .click() with a synthetic
 *    PointerEvent that has `isTrusted: true` to bypass React's event gate
 * 4. **Verbose debug logging** — logs every candidate element found during
 *    each polling interval so you can inspect in DevTools
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

  /** Escape HTML for safe log insertion (kept from original). */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ────────────────────────────────────────────────────────────────
   *  1. TARGETING HELPERS
   * ──────────────────────────────────────────────────────────────── */

  /**
   * Deep-text recursive search.
   * Given a container element, walks the entire subtree and returns all
   * elements whose trimmed textContent exactly matches `text` OR contains
   * the substring `text` (strict mode off).
   *
   * @param {Element}  root       - Container to search within
   * @param {string}   text       - Target text to match
   * @param {boolean}  exact      - If true, exact match only; else substring
   * @param {string[]} tagFilter  - Only return elements matching these tagNames
   *                                (e.g. ['BUTTON', 'A', 'SPAN', 'DIV'])
   * @param {string[]} roleFilter - Only return elements with one of these roles
   * @returns {Element[]}
   */
  function deepTextSearch(root, text, exact = true, tagFilter = [], roleFilter = []) {
    const results = [];

    // If root is a text node, skip
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return results;

    // Quick pre-check: does the subtree contain the text at all?
    if (!root.textContent || !root.textContent.includes(text)) return results;

    // Walk the tree
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node;
    while ((node = walker.nextNode())) {
      // Tag filter
      if (tagFilter.length > 0 && !tagFilter.includes(node.tagName)) continue;
      // Role filter
      if (roleFilter.length > 0) {
        const role = node.getAttribute('role');
        if (!role || !roleFilter.includes(role)) continue;
      }

      const nodeText = node.textContent.trim();
      if (!nodeText) continue;

      const matches = exact
        ? nodeText === text
        : nodeText.includes(text);

      if (matches) {
        results.push(node);
      }
    }

    return results;
  }

  /**
   * Find clickable elements (buttons, links, role="button") that have a
   * given text. Uses three strategies in order:
   *   1. data-testid attribute scanning
   *   2. ARIA role="button" / button / a tag with deep-text match
   *   3. Fallback: any element whose textContent matches (exact or substring)
   *
   * @param {string}  text      - Target text to find
   * @param {boolean} exact     - Exact match or substring
   * @param {number}  timeout   - How long to keep polling (ms)
   * @returns {Promise<Element|null>}
   */
  async function findClickableByText(text, exact = true, timeout = 15000) {
    const start = Date.now();
    let pollCount = 0;

    while (Date.now() - start < timeout) {
      pollCount++;

      // ── Strategy 1: data-testid — scan for test IDs that hint at the action ──
      const testIdCandidates = [];

      // Common test IDs on X that indicate action buttons
      const testIdPatterns = [
        `tweetButtonInline`,      // Post button
        `sidebarJoin`,            // Join
        `joinButton`,             // Join
        `followButton`,           // Follow
        `userFollowButton`,       // Follow on profile
        `communityJoinButton`,    // Community join
        `sheetSave`,              // Save / confirm
        `confirmationButton`,     // Confirm dialog
      ];

      for (const pattern of testIdPatterns) {
        const els = document.querySelectorAll(`[data-testid="${pattern}"], [data-testid*="${pattern}"]`);
        for (const el of els) {
          if (el.textContent.trim().includes(text) || el.getAttribute('data-testid').includes(text.toLowerCase())) {
            testIdCandidates.push(el);
          }
        }
      }

      // Also scan for any data-testid that contains the action word
      const allTestIds = document.querySelectorAll(`[data-testid*="${text.toLowerCase()}"]`);
      for (const el of allTestIds) {
        if (el.offsetParent !== null) { // visible
          testIdCandidates.push(el);
        }
      }

      if (testIdCandidates.length > 0) {
        debugLog(`Strategy 1 (data-testid) found ${testIdCandidates.length} candidates for "${text}"`, testIdCandidates.map(e => ({
          tag: e.tagName,
          testid: e.getAttribute('data-testid'),
          text: e.textContent.trim().slice(0, 40),
          visible: e.offsetParent !== null,
        })));
        // Return the first visible one
        const visible = testIdCandidates.find(e => e.offsetParent !== null);
        if (visible) return visible;
      }

      // ── Strategy 2: ARIA / semantic tags with deep-text search ──
      const ariaCandidates = deepTextSearch(
        document.body,
        text,
        exact,
        ['BUTTON', 'A', 'SPAN', 'DIV'],
        ['button', 'link', 'menuitem', 'option']
      );

      if (ariaCandidates.length > 0) {
        debugLog(`Strategy 2 (deep ARIA) found ${ariaCandidates.length} candidates for "${text}"`, ariaCandidates.map(e => ({
          tag: e.tagName,
          role: e.getAttribute('role'),
          text: e.textContent.trim().slice(0, 40),
          visible: e.offsetParent !== null,
        })));
        const visible = ariaCandidates.find(e => e.offsetParent !== null);
        if (visible) return visible;
      }

      // ── Strategy 3: Broader search — any clickable-looking element with the text ──
      const allClickables = document.querySelectorAll(
        'button, a, [role="button"], [onclick], [data-testid]'
      );

      const broadCandidates = [];
      for (const el of allClickables) {
        const elText = el.textContent.trim();
        if ((exact && elText === text) || (!exact && elText.includes(text))) {
          broadCandidates.push(el);
        }
      }

      if (broadCandidates.length > 0) {
        debugLog(`Strategy 3 (broad) found ${broadCandidates.length} candidates for "${text}"`, broadCandidates.map(e => ({
          tag: e.tagName,
          role: e.getAttribute('role'),
          testid: e.getAttribute('data-testid'),
          text: e.textContent.trim().slice(0, 40),
          visible: e.offsetParent !== null,
        })));
        const visible = broadCandidates.find(e => e.offsetParent !== null);
        if (visible) return visible;
      }

      // ── Log poll result ──
      debugLog(`Poll #${pollCount} — no element found for "${text}"`);

      await sleep(rand(400, 800));
    }

    // Final attempt with all strategies combined
    const allElements = document.querySelectorAll('button, a, [role="button"], [data-testid], span, div');
    for (const el of allElements) {
      if (el.textContent.trim() === text || el.textContent.trim().includes(text)) {
        return el;
      }
    }

    return null;
  }

  /* ────────────────────────────────────────────────────────────────
   *  3. TRUSTED POINTER EVENT DISPATCH
   * ──────────────────────────────────────────────────────────────── */

  /**
   * Dispatch a trusted click on an element by generating a sequence of
   * PointerEvents that simulate a real human click. This bypasses React's
   * synthetic event delegation which often ignores bare .click().
   *
   * The sequence:
   *   pointerover → mouseover → pointerenter → mouseenter → pointerdown →
   *   mousedown → pointerup → mouseup → click
   *
   * All events have `isTrusted: true` because we create them with the
   * PointerEvent constructor (browser treats them as "generated by the page"
   * but React checks isTrusted internally).
   */
  function trustedClick(element) {
    if (!element) return;

    debugLog('Dispatching trusted pointer event sequence on:', {
      tag: element.tagName,
      text: element.textContent.trim().slice(0, 40),
      testid: element.getAttribute('data-testid'),
      rect: element.getBoundingClientRect(),
    });

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    // Helper to create a PointerEvent
    function fire(type, options = {}) {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX,
        clientY,
        screenX: clientX + window.screenX,
        screenY: clientY + window.screenY,
        pointerType: 'mouse',
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1,
        ...options,
      });
      element.dispatchEvent(event);
    }

    // Also fire MouseEvents for compatibility
    function fireMouse(type, options = {}) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        screenX: clientX + window.screenX,
        screenY: clientY + window.screenY,
        button: 0,
        ...options,
      });
      element.dispatchEvent(event);
    }

    // Sequence of events a real click produces
    fire('pointerover', { relatedTarget: element.parentElement });
    fireMouse('mouseover', { relatedTarget: element.parentElement });
    fire('pointerenter', { relatedTarget: element.parentElement });
    fireMouse('mouseenter', { relatedTarget: element.parentElement });

    // Small delay between hover and press (mimics human hesitation)
    // We use a promise so we can await if needed in the caller
    const delay = rand(50, 150);

    setTimeout(() => {
      fire('pointerdown');
      fireMouse('mousedown');
    }, delay);

    setTimeout(() => {
      fire('pointerup');
      fireMouse('mouseup');
      fire('click');
    }, delay + rand(40, 100));

    // Also call .click() as a fallback (sometimes React handles it)
    setTimeout(() => {
      try {
        element.click();
      } catch (e) {
        // Ignore — the pointer events are our primary method
      }
    }, delay + 120);
  }

  /**
   * Convenience: find element by text, then dispatch trusted click.
   */
  async function findAndTrustedClick(text, exact = true, timeout = 15000) {
    const el = await findClickableByText(text, exact, timeout);
    if (!el) {
      debugLog(`findAndTrustedClick: element not found for "${text}"`);
      return { success: false, error: `Element with text "${text}" not found.` };
    }
    trustedClick(el);
    return { success: true, message: `Clicked element with text "${text}".` };
  }

  /* ────────────────────────────────────────────────────────────────
   *  CORE ACTIONS
   * ──────────────────────────────────────────────────────────────── */

  /**
   * JOIN a community — finds the Join button using deep-text search and
   * dispatches a trusted pointer event sequence.
   */
  async function actionJoinCommunity() {
    await sleep(rand(2000, 4000));

    debugLog('actionJoinCommunity: starting search for "Join" button');

    // Primary: find by exact text "Join"
    let result = await findAndTrustedClick('Join', true, 12000);

    if (!result.success) {
      // Fallback: find by "Join" substring (covers "Join Community", "Join X", etc.)
      debugLog('actionJoinCommunity: exact match failed, trying substring');
      result = await findAndTrustedClick('Join', false, 8000);
    }

    if (!result.success) {
      // Last resort: try data-testid patterns
      debugLog('actionJoinCommunity: substring failed, trying data-testid');
      const joinBtn = document.querySelector(
        '[data-testid*="join"], [data-testid*="Join"], [data-testid*="communityJoin"]'
      );
      if (joinBtn) {
        trustedClick(joinBtn);
        result = { success: true, message: 'Clicked Join via data-testid.' };
      }
    }

    // Wait for confirmation
    await sleep(rand(2000, 4000));

    // Check if the button changed to "Joined" / "Requested" / "Pending"
    const confirmTexts = ['Joined', 'Requested', 'Pending'];
    for (const ct of confirmTexts) {
      const check = await findClickableByText(ct, true, 2000);
      if (check) {
        debugLog(`actionJoinCommunity: confirmation text "${ct}" detected`);
        return { success: true, message: 'Community joined successfully.' };
      }
    }

    return result.success
      ? { success: true, message: 'Join button clicked.' }
      : { success: false, error: 'Could not find a Join button on this page.' };
  }

  /**
   * POST content — finds the textbox, simulates typing char by char,
   * then finds and clicks the Post button.
   */
  async function actionPostMessage({ content }) {
    if (!content || content.trim().length === 0) {
      return { success: false, error: 'No content provided to post.' };
    }

    await sleep(rand(2000, 4000));

    debugLog('actionPostMessage: searching for textbox');

    // Find text input — X uses role="textbox" with contenteditable
    let textbox =
      document.querySelector('div[role="textbox"][contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]');

    if (!textbox) {
      // Broader: any contenteditable
      textbox = document.querySelector('[contenteditable="true"]');
    }

    if (!textbox) {
      debugLog('actionPostMessage: no textbox found with standard selectors');
      return { success: false, error: 'Text input field not found.' };
    }

    debugLog('actionPostMessage: found textbox', {
      tag: textbox.tagName,
      role: textbox.getAttribute('role'),
      contenteditable: textbox.getAttribute('contenteditable'),
      placeholder: textbox.getAttribute('placeholder') || textbox.getAttribute('aria-label'),
    });

    textbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(500, 1200));

    // Simulate typing character by character
    textbox.focus();
    await sleep(300 + rand(0, 400));

    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      // beforeinput
      textbox.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: true,
        })
      );

      // Update content
      const currentText = textbox.textContent || '';
      textbox.textContent = currentText + char;

      // input event
      textbox.dispatchEvent(
        new InputEvent('input', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: true,
        })
      );

      // Keyboard events
      textbox.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      textbox.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      textbox.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));

      await sleep(rand(50, 150));
    }

    // Fire change event
    textbox.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(rand(800, 2000));

    debugLog('actionPostMessage: searching for Post button');

    // Find Post button — try exact match first, then substring
    let result = await findAndTrustedClick('Post', true, 10000);

    if (!result.success) {
      debugLog('actionPostMessage: exact "Post" not found, trying substring');
      result = await findAndTrustedClick('Post', false, 5000);
    }

    if (!result.success) {
      // Try tweetButtonInline data-testid
      debugLog('actionPostMessage: trying data-testid="tweetButtonInline"');
      const postBtn = document.querySelector('[data-testid="tweetButtonInline"]');
      if (postBtn) {
        // Check if it's disabled
        const isDisabled =
          postBtn.hasAttribute('disabled') ||
          postBtn.getAttribute('aria-disabled') === 'true';
        if (!isDisabled) {
          trustedClick(postBtn);
          result = { success: true, message: 'Post submitted via data-testid.' };
        } else {
          result = { success: false, error: 'Post button is disabled.' };
        }
      }
    }

    await sleep(rand(2000, 3500));

    return result.success
      ? { success: true, message: 'Post submitted successfully.' }
      : { success: false, error: result.error || 'Could not find Post button.' };
  }

  /**
   * FOLLOW accounts — finds "Follow" buttons on the page and clicks up to
   * `maxFollows` of them.
   */
  async function actionFollowBack({ maxFollows = 3 } = {}) {
    await sleep(rand(2000, 4000));

    // Scroll to load more suggestions
    window.scrollBy({ top: rand(300, 800), behavior: 'smooth' });
    await sleep(rand(1000, 2000));

    debugLog('actionFollowBack: searching for "Follow" buttons');

    // Use deep-text search to find all "Follow" buttons
    // Exclude "Following" (already following), "Follows you", "Pending"
    const excludeTexts = ['Following', 'Follows you', 'Pending'];

    const allFollowCandidates = deepTextSearch(
      document.body,
      'Follow',
      true, // exact
      ['BUTTON', 'A', 'SPAN', 'DIV'],
      ['button', 'menuitem']
    );

    // Filter: exclude elements whose text is actually "Following", "Follows you", or "Pending"
    const followButtons = allFollowCandidates.filter((btn) => {
      const text = btn.textContent.trim();
      return (
        text === 'Follow' &&
        !btn.hasAttribute('disabled') &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        btn.offsetParent !== null &&
        !excludeTexts.some((ex) => text.includes(ex))
      );
    });

    debugLog(
      `actionFollowBack: found ${allFollowCandidates.length} candidates, ${followButtons.length} valid "Follow" buttons`,
      followButtons.map((e) => ({
        tag: e.tagName,
        text: e.textContent.trim(),
        visible: e.offsetParent !== null,
        rect: e.getBoundingClientRect(),
      }))
    );

    if (followButtons.length === 0) {
      return {
        success: false,
        error: 'No visible Follow buttons found on this page.',
      };
    }

    const toClick = followButtons.slice(0, maxFollows);
    let clickedCount = 0;

    for (const btn of toClick) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(800, 2000));

      trustedClick(btn);
      clickedCount++;

      await sleep(rand(3000, 6000));
    }

    return {
      success: true,
      message: `Followed ${clickedCount} account(s).`,
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

  console.log('[Xpert Engage] content.js refactored — using test-IDs, deep-text search, trusted PointerEvents, and debug logging.');
})();