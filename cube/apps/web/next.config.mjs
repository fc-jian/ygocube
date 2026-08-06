/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${process.env.CUBE_API_URL || 'http://127.0.0.1:3001'}/:path*` },
    ];
  },
};

export default nextConfig;
