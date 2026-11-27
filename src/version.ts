/**
 * Version and release date, injected at bundle time from package.json and the release
 * workflow (esbuild.config.mjs `define`). Source runs (tests, `npm run dev`) use the fallbacks.
 */
declare const __GHOSTROW_VERSION__: string | undefined;
declare const __GHOSTROW_RELEASE_DATE__: string | undefined;

export const VERSION: string = typeof __GHOSTROW_VERSION__ === "string" ? __GHOSTROW_VERSION__ : "1.1.0";
/** The day this version was released (YYYY-MM-DD). A license covers versions released before its updates end. */
export const RELEASE_DATE: string = typeof __GHOSTROW_RELEASE_DATE__ === "string" ? __GHOSTROW_RELEASE_DATE__ : "2026-11-27";
