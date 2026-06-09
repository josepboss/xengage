# AI_RULES.md — Xpert Engage

## Tech Stack

- **Chrome Extension (Manifest V3)** — The app is a browser extension using the MV3 service worker model.
- **Vanilla JavaScript (no framework)** — The popup (`popup.js`) and background (`background.js`) are written in plain JavaScript without any framework or bundler.
- **Vanilla HTML/CSS** — The popup UI is hand-written HTML with scoped inline CSS (no UI library).
- **Web Extensions API** — Uses `chrome.cookies`, `chrome.storage.local`, `chrome.tabs`, `chrome.runtime`, `chrome.scripting`, `chrome.alarms`, `chrome.notifications`.
- **Content Script** — `content.js` is injected into `x.com` pages and communicates with the background via `chrome.runtime.onMessage`.
- **No TypeScript** — All files use plain `.js` extensions.
- **No npm / bundler** — No `package.json`, no Webpack, no Vite. All scripts are loaded directly from the extension manifest.

## Rules for Libraries & Patterns

1. **No npm packages allowed.** There is no `package.json` or bundler. All code must be written in plain JS/HTML/CSS. If a new feature requires a library, it must be small enough to inline (e.g., a 20-line utility function); otherwise, it must be authored manually.

2. **DO NOT import or require anything.** The extension runs without any module system. Global variables and IIFEs (Immediately Invoked Function Expressions) are the only acceptable patterns.

3. **Chrome Web Extensions API only.** Use `chrome.*` APIs exclusively for storage, tabs, messaging, cookies, scripting, etc. Do not use `fetch` for anything related to the app's own state — use `chrome.storage.local`.

4. **CSS must be inline in popup.html or in a minimal `<style>` block.** No CSS frameworks (Tailwind, Bootstrap, etc.). All styles should be scoped and self-contained.

5. **No TypeScript, no JSX, no transpilation.** Write plain ES6+ JavaScript. Browser-compatible `async/await`, `const/let`, arrow functions, template literals, and destructuring are fine.

6. **Messaging pattern: background ↔ popup ↔ content script.** Background is central hub. Popup sends commands (START_WORKFLOW, STOP_WORKFLOW, etc.). Background dispatches tasks to content script in a tab via `chrome.tabs.sendMessage`. Always respond with `{ success: boolean, ... }` shape.

7. **No React, no Vue, no SPA framework.** The popup is a single static HTML page with DOM manipulation via `document.getElementById` and event listeners. This keeps the bundle tiny and load time instant.

8. **No icons or assets beyond the three SVG icons** (`icon16.svg`, `icon48.svg`, `icon128.svg`). No external fonts, images, or CDN resources.

9. **Anti-suspension delays are mandatory.** All timing constants (`TAB_LOAD_BUFFER_MIN`, `TASK_INTERVAL_MIN`, `humanSleep`) must be defined in one place (`background.js`) and use random variance. Do not hardcode delays.

10. **No try/catch unless specifically requested.** Errors should bubble up so the developer (or AI) can fix them. The only exceptions are `chrome.runtime.sendMessage` calls (popup may be closed) which already have `.catch(() => {})` patterns.

11. **Active DOM polling in content.js.** All element queries against X.com's React UI must use `waitForElementAndExecute(predicate, timeout, pollInterval)` which polls every 500ms for up to 15s. Never query the DOM once — X components mount asynchronously after the DOM reports `readyState === 'complete'`. Always check `offsetParent !== null` to confirm visibility.

12. **Button matching must be broad + resilient.** Use `querySelectorAll('button, [role="button"], a, span, div[role="button"]')` and match `textContent` case-insensitively. For matched inner nodes (e.g. `<span>`), use `.closest('button, [role="button"], a')` to find the actual clickable parent. Always verify the button is not disabled (`hasAttribute('disabled')`, `aria-disabled`, or `classList.contains('disabled')`) before clicking.

13. **Typing must use `document.execCommand('insertText')`.** Do NOT set `element.textContent` for typing — X's React state only listens to `execCommand` + `InputEvent('input')` events. Use a typewriter loop with 50-150ms randomised per-character delays. Re-focus the element and collapse the selection range before each character to keep React's cursor position intact.

14. **Content script messaging must include PING probe + retry.** Before dispatching any command, background.js must PING the content script. If PING fails, inject `content.js` programmatically via `chrome.scripting.executeScript` and wait 800ms for initialisation. The full command send must be wrapped in a retry loop (up to 3 attempts) with exponential backoff, and use `return true` in the `onMessage.addListener` callback to keep the async channel open.