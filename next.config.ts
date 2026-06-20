import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
  serverExternalPackages: [
    '@tensorflow/tfjs',
    '@vladmandic/face-api',
    'canvas',
    'fluent-ffmpeg',
    'ffmpeg-static',
    'ffprobe-static',
  ],
}

export default nextConfig
