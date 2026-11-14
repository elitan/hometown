import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // point-cloud decoding uses laz-perf's WebAssembly; load it from node_modules instead of bundling
  serverExternalPackages: ['copc', 'laz-perf', 'geotiff'],
};

export default nextConfig;
