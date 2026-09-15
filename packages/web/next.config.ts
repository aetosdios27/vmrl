import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.VMRL_LOCAL_DEMO === "1" ? ".next-demo" : ".next",
  reactCompiler: true,
};

export default nextConfig;
