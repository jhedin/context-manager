# Requirements: Custom Context Manager (V1)

## 1. Introduction
The **Custom Context Manager** is an extension for Claude Code (leveraging the Agent SDK) designed to overcome context limits through two primary, decoupled mechanisms:
1. **Automated "Brake" (Plan Mode Enforcement):** Automatically monitoring context usage and forcing the agent into "Plan Mode" when thresholds are reached to ensure the next steps are documented before potential context clearing.
2. **Manual "Scalpel" (Interactive Pruning UI):** A slash command that opens a multi-select dashboard for surgically truncating historical tool results while preserving reasoning and session integrity.

## 2. User Stories
### Feature 1: Automated Plan Mode Brake (Event-driven)
- When the agent's context usage exceeds 80% (200,000 tokens), the system shall programmatically switch the agent's `permissionMode` to `'plan'`.
- The system shall inject a collaborative instruction to the agent: *"We're nearing the end of the context limit. Let's pause for now, and come up with next steps for after compacting. Use EnterPlanMode to summarize our progress so we don't lose the thread after the reset."*

### Feature 2: Manual Pruning Scalpel (Command-driven)
- The system shall provide a `/compact-ui` slash command to open the Context Management Dashboard.
- **Overview View:** The user shall be able to see token usage grouped by "Topic Blocks" (segmented by planning phases) and select topics for bulk pruning.
- **Dive Deeper View:** The user shall be able to inspect individual tool results within a topic and selectively truncate "fat" outputs (e.g., > 2KB file reads or logs).
- **DAG-Safe Execution:** The system shall mutate message payloads within the existing history array, preserving all `uuid` and `parentUuid` pointers to maintain session integrity.

## 3. Non-Functional Requirements
- **Reliability:** Must ensure the session history chain is not broken during pruning.
- **Performance:** Pruning logic and UI must respond in < 200ms to avoid interrupting the user flow.
- **Security:** Must use existing OAuth credentials via the SDK (`apiKeySource: "none"`) to respect subscription limits.

## 4. Out of Scope
- **Automatic Pruning:** The system will not truncate history without explicit user confirmation in the UI.
- **Non-Linear History Insertion:** Deferring the ability to insert new messages into the middle of the history chain for a future version.
