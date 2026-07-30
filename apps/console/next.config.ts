import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg stays a Node external (native optional deps confuse the bundler).
  serverExternalPackages: ['pg'],
};

export default nextConfig;
