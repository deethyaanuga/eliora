/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile the shared workspace package (it ships raw TypeScript).
  transpilePackages: ["@eliora/shared"],
};

export default nextConfig;
