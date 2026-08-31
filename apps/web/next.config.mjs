/** @type {import('next').NextConfig} */
// FIGYELEM: a rewrites() a `next build` alatt ertekelodik ki, es a celcim a
// .next/routes-manifest.json-ba egetodik. Az API_INTERNAL_URL-t ezert BUILD
// IDOBEN kell megadni (lasd deploy/Dockerfile.web ARG-jat) - futasidoben mar
// nincs hatasa a proxyra.
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
