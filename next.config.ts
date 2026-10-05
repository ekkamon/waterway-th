import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Runtime snapshots are written at run time; never bundle stale ones into the build.
  outputFileTracingExcludes: {
    "*": ["./data/**"],
  },
  // The CCTV gauge reader decodes video with ffmpeg.wasm inside a worker thread, which file tracing
  // cannot see (the worker is created from a string and loads these packages at run time).
  serverExternalPackages: ["@ffmpeg/ffmpeg", "@ffmpeg/core"],
  outputFileTracingIncludes: {
    "*": ["./node_modules/@ffmpeg/ffmpeg/**", "./node_modules/@ffmpeg/core/**"],
  },
};

export default nextConfig;
