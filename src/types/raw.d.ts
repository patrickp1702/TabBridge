/** Vite `?raw` imports — the file's text as a string (used for the connector script template). */
declare module "*?raw" {
  const text: string;
  export default text;
}

/** Injected by scripts/build.mjs (Vite `define`); identifies the build every bundle came from. */
declare const __BUILD_ID__: string;
