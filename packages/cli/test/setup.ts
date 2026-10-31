// Strip host-shell session env vars so the Arbor context resolvers under
// test fall through to platform-input-derived keys instead of picking up
// whatever the dev's terminal happens to export.
delete process.env.ARBOR_CONTEXT_ID;

// Strip CLAUDE_ENV_FILE: session-start.py appends `export ARBOR_CONTEXT_ID=…`
// to it, so a dev running the suite inside a Claude Code session would write
// test fixture keys into their own real shell setup file.
delete process.env.CLAUDE_ENV_FILE;

// Strip *_PROJECT_DIR vars: shared-hooks/session-start.py prefers them over
// JSON cwd / process cwd, so a dev running tests inside a Claude Code /
// StarFactory session would otherwise have the hook read the *real*
// repo's .arbor/ instead of the test tmpDir.
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.STARFACTORY_PROJECT_DIR;

// Codex exports its thread into shell children; isolate resolver fixtures.
delete process.env.CODEX_THREAD_ID;

// Global Trace2 listeners (e.g. git-ai) can keep writing Git objects after a
// fixture's command exits, racing rmSync with ENOTEMPTY. An explicit "0"
// overrides trace2.eventTarget for this test process and its Git descendants;
// deleting the variable would still inherit the user's global configuration.
process.env.GIT_TRACE2_EVENT = "0";
