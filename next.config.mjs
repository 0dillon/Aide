/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: import.meta.dirname,
  // msedge-tts must run as a real node module — webpack-bundling breaks its
  // websocket transport and the TTS route hangs.
  serverExternalPackages: ["msedge-tts"],
};

export default nextConfig;
