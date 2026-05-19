# HybridSync: Master Project Context & Architecture Document

This document serves as the absolute source of truth for the HybridSync hackathon project. It contains all architectural decisions, feature requirements, and technical constraints. **Claude Code should read this entirely before generating any project files.**

## 1. Project Overview
**HybridSync** is an enterprise hybrid-work scheduling tool. It optimizes in-person office days by analyzing digital communication to build a "Dependency Graph" of who actually works with whom, ensuring teams and cross-functional collaborators are in the office on the same days.

**Core Philosophy:** "Privacy by Design." We do not scan private DMs. We use a Zero-Knowledge/Local-First approach where possible, sending only mathematical dependency scores to the central server, never the raw chat text.

---

## 2. Tech Stack
* **Backend:** Node.js, Express, Slack Bolt API (running in Socket Mode for the project).
* **Frontend (Admin):** React.js (Dashboard for HR/Managers).
* **Frontend (Employee):** Slack App Home (Block Kit UI).
* **Database:** Firebase (Firestore/Realtime DB) to hold schedules, mock HR data, and dependency graphs.
* **AI Engine:** Claude API (Anthropic).

---

## 3. The "Batch + Stream" Architecture
To handle real-time updates and heavy AI processing cost-effectively, the backend is split into two flows:

### A. The Stream (Real-Time, Deterministic, NO AI)
* Uses Slack Event Subscriptions (Webhooks via Socket Mode).
* Listens 24/7 for explicit regex keywords (e.g., `wfh`, `working from home`, `sick`).
* **Action:** Instantly updates Firebase and triggers cascading smart alerts to the user's dependencies (e.g., "Azhar just switched to WFH today").

### B. The Batch (Scheduled, AI-Driven)
* **Daily Sweep (7:00 AM):** Light Claude API call. Scans the last 24 hours of public messages for ambiguous scheduling intent that the regex missed.
* **Weekly Mapping (Sunday 2:00 AM):** Heavy Claude API call. Processes 30 days of public messages/system pings to calculate a Dependency Score (1-10) between users based on volume, recency, and context. Outputs a strict JSON graph.

---

## 4. Agentic AI Implementation (The Orchestrator)
We are not using passive AI; we are using an **Agentic ReAct (Reason + Act) Loop**.
The Claude AI acts as the Orchestrator with the goal to *minimize collaboration loss*.
It has access to the following Node.js functions as **Tools**:
1.  `get_dependency_graph(userId)`: Fetches edges from Firebase.
2.  `send_slack_negotiation(userId, options)`: Sends interactive Block Kit DMs to propose schedule changes.
3.  `update_schedule_db(userId, date, status)`: Writes the final decision to Firebase.

---

## 5. User Interfaces & Role-Based Access Control (RBAC)
We have 3 tiers of users based on the Principle of Least Privilege:

### Tier 1: Global Admin (HR)
* **UI:** React Web Dashboard.
* **Capabilities:** "God View". Sees the entire company JSON dependency graph to spot macro silos. Cannot read messages.

### Tier 2: Team Manager
* **UI:** React Web Dashboard (Filtered).
* **Capabilities:** "Squad View". Sees only their team. **Crucial Feature:** Can set **"Anchor Days"** (e.g., "Team Alpha is mandatory WFO on Tuesdays"). The AI schedules around these anchors.

### Tier 3: Individual Contributor (Employee)
* **UI:** Slack App Home Tab & DMs.
* **Capabilities:** "Me View". Sees their personal week schedule. Can click buttons to override days.
* **The Proximity Paradox Fix:** Includes a "Settings" UI to manually add a 10/10 dependency for physical desk-neighbors who don't use Slack.

---

## 6. Implementation Priorities for Claude Code
When starting the build, follow this sequence:

1.  **Phase 1: Foundation (Slack + DB)**
    * Initialize Node.js + Bolt app in Socket Mode (`app.js`).
    * Initialize Firebase connection.
    * Set up dummy HR attendance data (Team Availability DB) replacing the Keka API.
2.  **Phase 2: The Stream & Employee UI**
    * Implement the Regex "WFH" listener and DB update.
    * Build the `app_home_opened` event to render the Block Kit schedule UI.
    * Implement interactive Block actions (Override buttons).
3.  **Phase 3: The Agentic Brain**
    * Integrate Claude API.
    * Build the ReAct loop orchestration.
    * Wire up the Node.js tools (`get_dependency_graph`, `send_slack_negotiation`).
4.  **Phase 4: The React Admin Dashboard**
    * Spin up a React app.
    * Fetch graph data from Firebase and render a visual node network (using libraries like React Flow or D3).
