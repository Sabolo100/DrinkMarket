/** @type {import('next').NextConfig} */
const apiInternal = process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    // A bongeszo azonos originrol eri el az API-t -> a session cookie mukodik,
    // es nincs szukseg CORS-ra (spec 29.1).
    return [{ source: '/api/:path*', destination: `${apiInternal}/api/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'x-content-type-options', value: 'nosniff' },
        { key: 'referrer-policy', value: 'same-origin' },
        { key: 'x-frame-options', value: 'DENY' },
      ],
    }];
  },
};

export default nextConfig;
