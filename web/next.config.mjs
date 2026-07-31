/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow large request bodies for local part uploads (dev-only storage backend).
  experimental: {
    serverActions: { bodySizeLimit: "256mb" },
  },
};

export default nextConfig;
