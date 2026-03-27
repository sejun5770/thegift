/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig = {
  output: 'standalone',
  ...(basePath ? { basePath, trailingSlash: true } : {}),
};

module.exports = nextConfig;
