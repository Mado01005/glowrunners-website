/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ["googleapis", "google-auth-library"],
};

module.exports = nextConfig;
