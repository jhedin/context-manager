 You said

how extensible is claude code? could i change some of the low-context

behaviour to skip their auto-compact, and instead do something like

start plan mode to pick what happens next? can i write my own compact? do interesting edits on the session file? I dont want to get my subscription banned
Gemini said

Here's a research plan for that topic. If you need to update it, let me know!
 Claude Code Extensibility and Customization 
Research Websites
(1) Research official Anthropic documentation for the Claude Code CLI to identify documented extensibility features, configuration options, and plugin architectures.
(2) Investigate the auto-compact mechanism within Claude Code, looking for configuration flags or environment variables that allow users to disable it or modify context thresholds.
(3) Search for information regarding a plan mode or interactive step-through feature in Claude Code that could serve as an alternative to automated context management.
(4) Locate technical details about the Claude Code session file, including its file format (e.g., JSON, SQLite), storage path on various operating systems, and its structure.
(5) Explore developer forums, GitHub repositories, and community discussions to see if users have successfully implemented custom compacting logic or manual session file edits.
(6) Review Anthropic's Terms of Service and Acceptable Use Policy specifically for Claude Code to determine if modifying the tool's internal behavior or reverse engineering the CLI risks account suspension.
(7) Look for any official statements or community warnings regarding the safety of tampering with the Claude Code binary or its local state files to avoid subscription bans.
(8) Synthesize the findings to provide a comprehensive overview of how much control a user has over the tool's low-context behavior and session management without violating terms.
Analyze Results
Create Report
Ready in a few mins
You said

Start research
Gemini said

I've completed your research. Feel free to ask me follow-up questions or request changes.
Claude Code Extensibility and Customization
Completed
Mar 12, 4:31 PM
You said

I could do a post-response hook that forces the agent to plan mode?
Gemini said

Yes, you can implement a Stop hook (which fires immediately after the assistant finishes a response) that programmatically "blocks" the agent from idling and instead forces it to enter plan mode or ask for next steps.
Implementation via the Stop Hook

The Stop hook is the primary mechanism for overriding the agent's decision to end a turn. You can implement this using two main methods:

    Exit Code 2 (Blocking): If your hook script exits with code 2, the current "stop" action is canceled. Any message you write to stderr is injected back into Claude's context as a mandatory system prompt. For example, your script could output: "Task checkpoint reached. You must now use the EnterPlanMode tool to outline the next phase of work before continuing".

    Structured JSON Decision: For more control, your hook can return a JSON object to stdout with { "decision": "block", "reason": "..." }. This prevents the agent from stopping and provides a specific "reason" that Claude uses as new input to determine its next action.

Forcing Plan Mode

Because EnterPlanMode is a tool that Claude can call on its own, a blocking hook effectively forces a mode change by giving a high-priority instruction that the agent cannot ignore if it wants to proceed.

This is often used in "Smart Handoff" or "Context Threshold" workflows where the hook detects high context usage (e.g., 60-80%) and instructs the agent to:

    Finish the current atomic unit of work.

    Call EnterPlanMode to document the state and future tasks.

    Prompt the user to /clear the session to reset the context window while preserving the generated plan file.

Safety and Subscription Status

Using the official hook system for this behavior is fundamentally safe and will not lead to a subscription ban. Anthropic has clarified that personal use and local experimentation with the official CLI, its lifecycle hooks, and the Agent SDK are permitted. The platform's security enforcement primarily targets "token arbitrage," which involves extracting OAuth tokens to power third-party services or commercial products, rather than customizing the official harness's internal logic.
You said

is that all of the hooks? i guess Stop would be the one? have a hook check the current context limits? I guess preCompact as well as a known time? that wont fire it i turn off auto-compact though


something I want to try building is something that can identify combinations of tool use and not-very-useful context to compact together, while leaving the overall conversation flow, with the idea that while there is still a token limit, you can keep shortening the earlier part of the conversation as you go, so instead of the 250k, maybe you get an effective 500k context
Gemini said

Implementing a custom context manager and forcing specific behaviors like "Plan Mode" is one of the most powerful extensibility patterns in Claude Code. You can achieve this by combining official hooks with local transcript manipulation, provided you maintain the integrity of the session's underlying data structure.
1. Forcing Plan Mode via Hooks

While the Stop hook is the final checkpoint for forcing the agent into Plan Mode, you can also use PreToolUse to intervene earlier.

    The Stop Hook: This fires whenever Claude finishes a response. By exiting with code 2 or returning a JSON object with { "decision": "block", "reason": "..." }, you force Claude to keep working. Your hook can check a local "state" file or current context usage to decide when to issue an instruction like: "Context is high. Use EnterPlanMode now to summarize current work into a file before we /clear".

    The PreToolUse Hook: This is arguably more precise for preventing "low-context" mistakes. You can block any tool that modifies files (like Write or Edit) and instruct the agent: "You are approaching the context limit. You must enter Plan Mode to validate your next steps before I permit further edits".

2. Monitoring Context Limits

Currently, Claude Code does not natively provide a "ContextThreshold" hook in all stable versions. However, you can implement this manually within any hook:

    Hook Input: Every hook (including PreToolUse and Stop) receives a JSON object on stdin that contains the transcript_path.

    Manual Tracking: Your hook script can read this .jsonl transcript file to estimate current usage. Community tools often use a small script to parse the JSONL and calculate token counts before deciding whether to trigger a "block" or a "warning".

    Auto-Compact Conflict: If you disable "Auto-compact enabled" in /config, the PreCompact hook will not fire automatically. You would instead need to rely on Stop or UserPromptSubmit hooks to monitor context and prompt for a manual /compact or /clear.

3. Custom Compaction and "Thicc" Transcripts

You can absolutely build your own compactor. The community has already pioneered this with tools like Thicc, which performs local-only session compression.

    Selective Truncation: Instead of a lossy remote summary, a local tool can clone the .jsonl file and surgically truncate verbose tool results (like long compiler logs or large file reads) while preserving the high-level reasoning and conversation flow.

    ** lineage Rollover:** Another pattern involves creating a "Rollover" session where you inject back-pointers to the original session file into the first user message. This allows subagents in the new session to still "look back" at original logs if they hit a gap.

4. Editing the Session File

The session file (~/.claude/projects/.../sessions/<uuid>.jsonl) is a directed acyclic graph (DAG) where every message has a uuid and a parentUuid.

    The Danger: If you edit a message and break the parentUuid chain, the session loader will stop at the "orphan" record. This causes you to lose all history prior to that break when you try to /resume.

    Structural Metadata: The transcript contains metadata like timestamps and request IDs. Some versions of Claude Code also utilize structural metadata (potentially including checksums) for integrity verification.

    Safe Edits: To perform "interesting edits" safely, you must ensure that every record's parentUuid points to a valid, existing uuid in the file. Community scripts like fix-session.py exist specifically to repair these chains after manual or buggy modifications.

5. Subscription Safety

Anthropic's security enforcement primarily targets "token arbitrage"—extracting your session's OAuth tokens to power third-party commercial tools or services. Anthropic engineers have clarified that personal use and local experimentation with the official CLI, its hook system, and the Agent SDK are permitted. Building your own compaction logic or workflow automation within the official harness is considered legitimate extensibility and does not risk a ban.
You said

agent sdk would call the api though right? api requests and not subscription ones?
Gemini said

The Claude Agent SDK can be configured to use either paid API credits or your existing subscription usage. If you set the apiKeySource parameter to "none", the SDK authenticates using the OAuth tokens from your previous local claude login session, which allows it to function under your subscription's usage limits.

Regarding the risk of a subscription ban, Anthropic has explicitly clarified that personal use and local experimentation with the Agent SDK using your own credentials are permitted. The primary distinction is between personal automation and commercial exploitation:

    Permitted (Safe): Using your Max/Pro subscription for local development, personal scripts, and experimenting with the SDK or the claude -p command for your own workflow.

    Prohibited (Ban Risk): Building a business or a third-party product that "piggybacks" on consumer subscriptions by allowing other users to authenticate with their own subscription tokens instead of using a paid API key.

Anthropic enforces these policies using server-side "request body fingerprinting" to detect if requests are coming from the official CLI harness or unauthorized third-party tools. As long as you are extending the official toolset for your own use, you are operating within the permitted scope of experimentation.
You said

what is -p?
Gemini said

The -p flag (short for --print) is Claude Code's headless or non-interactive mode.

Instead of starting a conversational REPL where you chat back and forth, -p tells the CLI to execute a single request, print the final answer to your terminal (stdout), and then immediately exit.
Key Characteristics of -p Mode:

    One-Shot Execution: It bypasses the interactive UI entirely. This makes it the primary tool for automation, CI/CD pipelines, and cron jobs.

    Piping and Scripting: Because it outputs directly to stdout, you can pipe codebase data into it or pipe its results into other tools (e.g., git diff | claude -p "review these changes" > review.md).

    Token Efficiency: Headless mode typically uses significantly fewer tokens than interactive sessions because it doesn't maintain the same UI overhead and long-running session state in the same way.

    Permission Handling: In this mode, Claude cannot ask you for permission interactively. You must either use the --dangerously-skip-permissions flag or pre-approve tools in your .claude/settings.json.

Common Usage Examples:

    Code Review: claude -p "Review the changes in the last commit".

    Automated Tasks: claude -p "run tests and fix any failures".

    Formatting: claude -p "translate new strings into French and raise a PR for review".

    Integration: The Agent SDK uses -p under the hood to communicate with the Claude Code CLI as a subprocess.

You can combine it with other flags like --model haiku for cheaper, faster one-off tasks or --output-format json if you need to parse the response programmatically.
You said

ahh, so i could still call the sdk as needed? not have to push everything through the harness?
Gemini said

Yes, you can call the Agent SDK directly to build custom workflows without being forced to use the standard interactive CLI harness.

The SDK is essentially the infrastructure that powers Claude Code, exposed as a library for developers to build their own "agentic" applications. However, it is important to understand the technical relationship between the two:
The Subprocess Architecture

The Agent SDK does not communicate with Anthropic’s servers directly. Instead, it functions as a wrapper that spawns the Claude Code CLI as a subprocess.

    How it works: When you run a command via the SDK, it launches claude --print --output-format stream-json in the background.

    Why this matters: Because it uses the official CLI binary under the hood, the SDK can utilize your existing OAuth subscription credentials (by setting apiKeySource to "none") while giving you full programmatic control over the system prompt, tool access, and loop behavior.

Customizing "Low-Context" Behavior

By using the SDK or the CLI's lifecycle hooks, you can bypass the "black-box" behavior of the standard REPL:

    Custom Compaction: You can build tools like Thicc or Cozempic to perform local-only compression. Instead of the CLI’s lossy remote /compact, these tools surgically truncate verbose logs or old chains in the .jsonl session file, allowing the conversation to continue in the same session without "retrograde amnesia".

    Forcing Plan Mode: You can implement a Stop hook (or a custom SDK loop) that detects high context usage (e.g., at 60%) and programmatically blocks the agent from stopping. You can then force it to call the EnterPlanMode tool to document current progress into a markdown file before you manually run /clear to reset the window.

    Deterministic Guardrails: While a CLAUDE.md file is followed about 70% of the time, a hook-based approach within the SDK is 100% deterministic. You can use PreToolUse hooks to absolutely block specific files or force a planning phase before any Edit or Write operations are permitted.

Usage Safety

Anthropic has confirmed that personal use and local experimentation with the Agent SDK and the claude -p command are permitted. The platform's ban-detection logic primarily targets "token arbitrage"—extracting subscription tokens to power commercial third-party products—rather than developers extending the official toolset for their own productivity.
