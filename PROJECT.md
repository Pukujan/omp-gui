# PROJECT.md — omp-gui

Product: ChatGPT-style web GUI for the omp coding agent. A Node server spawns
`omp --mode rpc` per project and relays JSONL frames over WebSocket to a
responsive dark UI (desktop + phone, PWA). Single-user auth with rate limit and
lockout. Dev in Docker/WSL; edge on the tailnet at omp.design-bakery.com.

Authority: GitHub Issues (see AGENTS.md). Deliverable parent: #1.
Children: #2 UI parity, #3 projects/chats, #4 docker+mobile, #5 governance,
#6 auth hardening, #7 tailnet edge.
