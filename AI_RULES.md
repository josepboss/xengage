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