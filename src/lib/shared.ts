// Constants used by both the server and the browser. Keep this file free of
// server-only imports (SDK, database) so the client bundle stays small.

/** Appended to a reply the user stopped mid-stream, so the model knows it was cut off. */
export const STOPPED_NOTE = "\n\n_(stopped)_";
