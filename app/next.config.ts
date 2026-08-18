import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16はデフォルトでlocalhost以外のオリジンからの/_next/*リクエストを
  // クロスオリジンとしてブロックする。LAN IP経由での開発アクセスを許可する。
  allowedDevOrigins: ["192.168.1.11", "localhost", "127.0.0.1"],
};

export default nextConfig;
