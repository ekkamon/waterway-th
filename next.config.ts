import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Runtime snapshots are written at run time; never bundle stale ones into the build.
  outputFileTracingExcludes: {
    "*": ["./data/**"],
  },
  // The CCTV gauge reader spawns this bundled ffmpeg binary, which file tracing cannot see.
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "*": ["./node_modules/ffmpeg-static/ffmpeg*"],
  },
};

export default nextConfig;
