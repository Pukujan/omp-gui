# UI-SPEC — every control, its function, and its test

Source of truth: the two ChatGPT desktop screenshots (2026-09-29). Each row is a
versioned module: UI control → behavior → server/RPC mechanism → test id.
Anything not implementable over `omp --mode rpc` is marked **GAP** and must fail
closed with a visible notice, never silently.

## Left icon rail
| Control | Function | Mechanism | Test |
| --- | --- | --- | --- |
| Home | Go to empty state (deselect session, keep sidebar) | client route | T-UI-01 |
| Clock | Recent chats across all projects (mtime desc) | GET /api/recent | T-API-10 |
| Library | Session browser table: title, project, when, size; click = open | GET /api/recent (full) | T-API-10 |
| Blocks | Capabilities panel: skills, plugins, MCP servers, agents — list + enable/disable | GET/POST /api/capabilities (omp plugin/skill/agents via exec) | T-API-11 |
| Compass | Projects overview grid (path, session count, open) | GET /api/projects | T-API-02 |
| ⋯ | Settings modal: theme, approvals default, data dir, about/version | GET /api/info; settings persisted client+server | T-API-12 |
| ? (bottom) | Help: keybindings table + docs links | static | T-UI-02 |
| Avatar | Account menu: user, connection state, log out | /api/me, /api/logout | T-API-01 |

## Sidebar
| Control | Function | Mechanism | Test |
| --- | --- | --- | --- |
| ChatGPT ▾ (brand) | Workspace menu: server info, reload, log out | client + /api/health | T-UI-03 |
| 🔔 (bell, dot) | Notifications: session finished / needs input / error while you were elsewhere; dot = unread | WS control channel + server event fanout | T-API-13 |
| 🔍 | Search chats by title/content | GET /api/search?q= | T-API-14 |
| ✏️ New chat | New session in current project (Work) or global Chat | POST /api/sessions {kind} | T-API-15 |
| Pinned group | Pin/unpin projects & chats (persisted) | POST/DELETE /api/pins | T-API-16 |
| Project row ▾ | Collapse/expand chat list (persisted) | client + pins store | T-UI-04 |
| Chat row | Open that session (resume file) | WS ?resume= | T-API-15 |
| Chat row ⓘ/blue dot | Attention: inputRequired (pending dialog) / working | state from session pool | T-API-13 |
| Chat row ⋯ | Rename, export HTML, fork, delete | POST /api/sessions/:f/rename,export,fork; DELETE | T-API-17 |

## Top bar
| Control | Function | Mechanism | Test |
| --- | --- | --- | --- |
| Chat ⇄ Work | Mode: Chat = tool-free session (spawn --no-tools, no project); Work = full agent on project | session.kind at create | T-API-15 |
| Session title | Click to rename inline | set_session_name | T-API-17 |
| ⋯ (chat menu) | Compact now, handoff, export, share link, copy transcript | compact/handoff/export_html RPC; share = GAP notice | T-API-18 |
| People icon | Toggle subagents panel | get_subagents + subscription | T-API-19 |
| ⛶ | Fullscreen transcript (Fullscreen API) | client | T-UI-05 |
| ▥ | Split view: second pane with its own session/WS | client (two sessions) | T-UI-06 |

## Transcript
| Control | Function | Mechanism | Test |
| --- | --- | --- | --- |
| user bubble | rendered from message_start echo (no optimistic dup) | RPC echo | T-UI-07 |
| assistant markdown | streaming render, code blocks, links | message_update deltas | T-E2E-01 |
| thinking accordion | collapsible thinking_delta | details element | T-E2E-01 |
| tool card (Ran command etc.) | name+summary, expand args/result, running/done/error state | tool_execution_* | T-E2E-01 |
| Worked for X › | turn duration + step count, expand to per-step list | turn_start/turn_end + tool events | T-UI-08 |
| copy | copy message text | clipboard API | T-UI-09 |
| 👍/ | feedback logged to session (custom entry via prompt-less notice) | POST /api/feedback | T-API-20 |
| branch ⎇ | fork session at that assistant message | branch RPC (entryId) | T-API-18 |
| paused-goal chip | goal mode status: text + elapsed; ▶ resume (/goal), 🗑 clear, ⛶ expand | slash commands through prompt | T-API-21 |
| queue chips | steering/follow-up queue with ✕ remove | queue_update + remove_queued_message | T-API-22 |
| ask dialog | select/confirm/input/editor from agent → modal, answer routes back | extension_ui_request/response | T-E2E-02 |

## Composer
| Control | Function | Mechanism | Test |
| --- | --- | --- | --- |
| text + ↑ | send prompt; while streaming ↑ = stop (abort), Enter = follow-up, steer toggle | prompt/abort/steer | T-E2E-01 |
| + | attach image (file picker/paste → base64 → RPC `prompt.images`); text files via @path in the prompt | WS `prompt.images` | T-API-23 |
| 🖼 generate | prompt → image rendered in transcript, attachable to the next turn | POST /api/image (ckff; model fallback) | T-API-23 |
| 🛡 Full access | approval mode selector: always-ask / write / full — applies to next session spawn, shown per session | spawn flag --approval-mode; session metadata | T-API-24 |
| model ▾ | ranked model list (rank/status/reason badges, vision/free filters), set_model | GET /api/models (IRE engine) → set_model | T-API-24 |
| Extra High ▾ | thinking level (only for capable models) | get_available_thinking_levels | T-API-25 |
| 🎤 | voice dictation (Web Speech API); hidden when unsupported | client | T-UI-10 |
| project chip | current project; click = switch project (new session) | client | T-UI-11 |
| Plugins chip | open Capabilities panel | client | T-UI-12 |
| 🖥 (right) | focus mode: hide sidebar + panels | client | T-UI-13 |

## Mobile
Sidebar → drawer (☰), panels → bottom sheets, composer sticky, PWA manifest +
install, touch targets ≥44px, safe-area. Tests: viewport 390px screenshot pass
+ tap-through of every visible control. T-UI-14.

## GAPs (fail closed, visible notice)
- share link (no RPC command) — button shows "not supported by omp rpc" instead of a dead control.
- 👍/👎 — logged to `data/feedback.jsonl` (no analytics backend).
- voice on browsers without SpeechRecognition — control hidden.
- chat delete — the session file lives on the host; the chat ⋯ menu offers export/handoff/fork and states that deletion is done from the host.
- plugin/skill enable-disable — `/api/capabilities` lists skills/plugins/MCP with their enabled state; toggling is host-side (rename `<name>` ↔ `<name>.disabled`).

## Status (2026-09-29, server v0.2.0)
Implemented and covered by `scripts/test-server.js` (18 tests) + `scripts/smoke.js`:
auth/lockout, projects, sessions with titles, pins, search, recents, capabilities,
feedback, image generation (mock + live provider), IRE-ranked model picker,
per-chat session isolation (two chats → two session files), protocol-v2 framing
(valid + interrupted/duplicate/oversized/non-UTF8), notification fanout, and one
real streamed agent turn.
