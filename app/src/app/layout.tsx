import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Newsreader, Inter, IBM_Plex_Mono, Noto_Serif_JP } from "next/font/google";
import "./globals.css";

// Newsreaderは日本語グリフを含まないため、日本語見出しのfont-serifには
// 反映されない(2026-08-18判明)。Noto Serif JPを主とし、Newsreaderは
// Latin表記(ロゴ等)向けに残す。
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

// Noto Serif JPはsubsetsに"japanese"を取らない(next/font/googleの型定義で
// 確認済み: 'cyrillic'|'latin'|'latin-ext'|'vietnamese'のみ)。日本語グリフは
// このフォント自体が標準で含んでおり、subsetsは追加の欧文字セット指定にすぎない。
const notoSerifJp = Noto_Serif_JP({
  variable: "--font-noto-serif-jp",
  subsets: ["latin"],
  weight: ["500", "700"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "ISMAY",
  description: "雑な入力から、まだタスクになっていない約束・責任を発見するAI個人参謀",
};

// [2026-08-25是正・Completion Gate 2] LayoutProps<"/">はNext.js 15が`next build`を
// 一度実行した後にのみ.next/types配下へ生成する型で、tsc単体実行(build未実行状態)では
// 解決できずTS2304になっていた。next build未実行でも解決できる明示的な型へ置き換える
// (Root Layoutが受け取るpropsは元々childrenのみのため、実質的に同じ意味)。
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="ja"
      className={`${newsreader.variable} ${notoSerifJp.variable} ${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-canvas text-ink">{children}</body>
    </html>
  );
}
