/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Enable Web Workers with proper TypeScript support
      config.module.rules.push({
        test: /\.worker\.ts$/,
        use: { loader: "worker-loader" },
      });
    }
    return config;
  },
};

export default nextConfig;
