// Global Trace2 listeners (e.g. git-ai) can keep writing Git objects after a
// fixture's command exits, racing rmSync with ENOTEMPTY. An explicit "0"
// overrides trace2.eventTarget for this test process and its Git descendants;
// deleting the variable would still inherit the user's global configuration.
process.env.GIT_TRACE2_EVENT = "0";
