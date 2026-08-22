/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: import.meta.dirname,
  // Two Next processes in one working tree share one build directory, and the
  // second one silently overwrites artifacts the first has already loaded —
  // which shows up much later as "Cannot find module '../chunks/ssr/...'" in
  // whichever server was there first. Anything running alongside your dev
  // server (a throwaway instance on another port, a production build) should
  // set AIDE_DIST_DIR to keep its output somewhere else entirely.
  distDir: process.env.AIDE_DIST_DIR || ".next",
};

export default nextConfig;
