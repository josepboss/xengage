/**
 * content.js — X.com DOM Interaction Engine
 *
 * Injected into all x.com pages by the manifest. Exposes a message listener
 * so the background service worker can dispatch commands (join, post, follow)
 * that are executed by safely querying the DOM using semantic selectors
 * (ARIA roles, data-testid, textContent matching) instead of fragile CSS classes.
 *
 * All actions include randomised delays to appear human-like.
 */

(function () {
  'use strict';

  /* ────────────────────────────────────────────────────────────────
   *  Utility Helpers
   * ──────────────────────────────────────────────────────────────── */

  /** Return a random integer between min and max (inclusive). */
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  /** Sleep for `ms` milliseconds. */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Simulate human typing into a contenteditable element.
   * Splits `text` into characters and dispatches `beforeinput` + `input` events
   * with a randomised delay (50-150ms) between each keystroke.
   */
  async function simulateTyping(element, text) {
    element.focus();
    // Focus may need a moment
    await sleep(300 + rand(0, 400));

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Dispatch a beforeinput event first (as real browsers do)
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: true,
        })
      );

      // Update the textContent progressively
      const currentText = element.textContent || '';
      element.textContent = currentText + char;

      // Dispatch the actual input event
      element.dispatchEvent(
        new InputEvent('input', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: true,
        })
      );

      // Dispatch a synthetic keydown/keyup for stealth
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: char, bubbles: true })
      );
      element.dispatchEvent(
        new KeyboardEvent('keyup', { key: char, bubbles: true })
      );

      // Random delay between keystrokes: 50-150ms
      await sleep(rand(50, 150));
    }

    // Trigger a final change event so React/Svelte listeners pick up the update
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Wait for an element matching `selector` to appear in the DOM.
   * Checks every 500ms until `timeout` ms have elapsed.
   * Returns the element or null.
   */
  async function waitForElement(selector, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(rand(300, 700));
    }
    // One last try
    return document.querySelector(selector);
  }

  /**
   * Wait for an element whose textContent (trimmed) equals `text`
   * and whose role or tag matches expectations.
   */
  async function waitForElementByText(role, text, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const candidates = document.querySelectorAll(`[role="${role}"]`);
      for (const el of candidates) {
        if (el.textContent.trim() === text) return el;
      }
      await sleep(rand(300, 700));
    }
    // Final attempt
    const candidates = document.querySelectorAll(`[role="${role}"]`);
    for (const el of candidates) {
      if (el.textContent.trim() === text) return el;
    }
    return null;
  }

  /* ────────────────────────────────────────────────────────────────
   *  Core Actions
   * ──────────────────────────────────────────────────────────────── */

  /**
   * JOIN a community on the current page.
   * Looks for a "Join" button by role="button" and exact text match.
   */
  async function actionJoinCommunity() {
    // Wait for page to settle
    await sleep(rand(2000, 4000));

    // Try finding the Join button using various strategies
    let joinBtn = await waitForElementByText('button', 'Join', 10000);

    if (!joinBtn) {
      // Fallback: look for any element with text "Join" that is clickable
      const allElements = document.querySelectorAll(
        'button, [role="button"], a, span'
      );
      for (const el of allElements) {
        const text = el.textContent.trim();
        if (
          text === 'Join' &&
          (el.tagName === 'BUTTON' ||
            el.getAttribute('role') === 'button' ||
            el.tagName === 'A')
        ) {
          joinBtn = el;
          break;
        }
      }
    }

    if (!joinBtn) {
      return { success: false, error: 'Join button not found on this page.' };
    }

    // Random pre-click hesitation
    await sleep(rand(800, 2000));

    // Scroll element into view smoothly
    joinBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(500, 1200));

    // Click
    joinBtn.click();

    // Wait to confirm the button text changes to "Joined" or "Requested"
    await sleep(rand(2000, 4000));

    const confirmTexts = ['Joined', 'Requested', 'Pending'];
    const postCheck = document.querySelector(`[role="button"]`);
    if (postCheck) {
      const pt = postCheck.textContent.trim();
      if (confirmTexts.some((t) => pt.includes(t))) {
        return { success: true, message: 'Community joined successfully.' };
      }
    }

    return { success: true, message: 'Join button clicked.' };
  }

  /**
   * POST content in a community on the current page.
   * Finds the textbox, simulates typing, then clicks the Post button.
   */
  async function actionPostMessage({ content }) {
    if (!content || content.trim().length === 0) {
      return { success: false, error: 'No content provided to post.' };
    }

    await sleep(rand(2000, 4000));

    // Find the text input — X uses role="textbox" with contenteditable
    let textbox = await waitForElement(
      'div[role="textbox"][contenteditable="true"]',
      12000
    );

    if (!textbox) {
      // Fallback: any contenteditable div
      textbox = await waitForElement('div[contenteditable="true"]', 8000);
    }

    if (!textbox) {
      return { success: false, error: 'Text input field not found.' };
    }

    // Scroll to the textbox
    textbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(500, 1000));

    // Simulate typing character by character
    await simulateTyping(textbox, content);

    // Short break after typing finishes
    await sleep(rand(800, 2000));

    // Find the Post button — exact text "Post" with role="button"
    let postBtn = await waitForElementByText('button', 'Post', 8000);

    if (!postBtn) {
      // Try data-testid approach
      postBtn = await waitForElement(
        'button[data-testid="tweetButtonInline"]',
        8000
      );
    }

    if (!postBtn) {
      return {
        success: false,
        error:
          'Post button not found. Text was typed but not submitted.',
      };
    }

    postBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(500, 1200));

    // Check if button is disabled before clicking
    if (
      postBtn.hasAttribute('disabled') ||
      postBtn.getAttribute('aria-disabled') === 'true'
    ) {
      return {
        success: false,
        error: 'Post button is disabled (content may be empty or invalid).',
      };
    }

    postBtn.click();

    await sleep(rand(2000, 3500));

    return { success: true, message: 'Post submitted successfully.' };
  }

  /**
   * FOLLOW accounts on the current Connect People / followers page.
   * Finds visible "Follow" buttons (excluding accounts already "Following")
   * and clicks up to `maxFollows` of them.
   */
  async function actionFollowBack({ maxFollows = 3 } = {}) {
    await sleep(rand(2000, 4000));

    // Scroll down a bit so more items load
    window.scrollBy({ top: rand(300, 800), behavior: 'smooth' });
    await sleep(rand(1000, 2000));

    // Find all Follow buttons — look for buttons with exact text "Follow"
    // Exclude: "Following" (already following), "Follows you" (mutual), "Pending"
    const allButtons = document.querySelectorAll(
      'button, [role="button"]'
    );
    const followButtons = [];

    for (const btn of allButtons) {
      const text = btn.textContent.trim();
      if (
        text === 'Follow' &&
        !btn.hasAttribute('disabled') &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        // Ensure it's not inside a disabled context
        btn.offsetParent !== null
      ) {
        followButtons.push(btn);
      }
    }

    if (followButtons.length === 0) {
      return {
        success: false,
        error: 'No visible Follow buttons found on this page.',
      };
    }

    // Limit to maxFollows
    const toClick = followButtons.slice(0, maxFollows);
    let clickedCount = 0;

    for (const btn of toClick) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(800, 2000));

      btn.click();
      clickedCount++;

      // Random delay between follows
      await sleep(rand(3000, 6000));
    }

    return {
      success: true,
      message: `Followed ${clickedCount} account(s).`,
      followed: clickedCount,
    };
  }

  /* ────────────────────────────────────────────────────────────────
   *  Route Guards — confirm we're on the right page
   * ──────────────────────────────────────────────────────────────── */

  /**
   * Check if the current URL is a community page.
   */
  function isCommunityPage() {
    return window.location.href.includes('/i/communities/');
  }

  /**
   * Check if the current URL is a connect_people / follow-recommendation page.
   */
  function isConnectPeoplePage() {
    return (
      window.location.href.includes('/i/connect_people') ||
      window.location.href.includes('/notifications') ||
      window.location.href.includes('/followers')
    );
  }

  /* ────────────────────────────────────────────────────────────────
   *  Message Listener — bridge from background.js
   * ──────────────────────────────────────────────────────────────── */

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Immediately respond to keep the port open
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

    // Send response back to background
    handler.then(sendResponse);
    return true; // Keep channel open for async response
  });

  // Signal that content script has loaded
  console.log('[Xpert Engage] content.js injected and ready.');
})();