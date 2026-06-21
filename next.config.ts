import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
  serverExternalPackages: [
    '@tensorflow/tfjs',
    '@tensorflow-models/coco-ssd',
    '@vladmandic/face-api',
    'canvas',
    'fluent-ffmpeg',
    'ffmpeg-static',
    'ffprobe-static',
  ],
}

export default nextConfig
