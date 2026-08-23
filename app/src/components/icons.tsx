import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** 「今日」ナビ用。太陽のモチーフ(サイドバーの他アイコンと線の太さを揃えた自作SVG)。 */
export function TodayIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </svg>
  );
}

/** Inboxナビ用。トレイのモチーフ。 */
export function InboxIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h5l2 3h4l2-3h5" />
      <path d="M5.5 5h13L21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6Z" />
    </svg>
  );
}

/** アカウント設定用。スライダーのモチーフ。 */
export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="15" cy="17" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** クイック入力導線用。マイクのモチーフ。 */
export function MicIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18v4M9 22h6" />
    </svg>
  );
}

/** 「今後」ナビ用。カレンダーのモチーフ。 */
export function CalendarIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

/** FN-NTF-01通知ベル用(2026-08-22追加)。ベルのモチーフ。 */
export function BellIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c0.5-0.5 2-2 2-6Z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  );
}

/** FN-WK-03「今日の最低ライン」ピン留め用(2026-08-22追加)。画鋲のモチーフ。 */
export function PinIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 2v6" />
      <path d="M7 8h10l-1.5 5H8.5L7 8Z" />
      <path d="M12 13v9" />
    </svg>
  );
}

/** UI-11 横断検索用(2026-08-22追加)。虫眼鏡のモチーフ。 */
export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-5-5" />
    </svg>
  );
}

/** UI-09 PEM(あなたの実行モデル)ナビ用(2026-08-23追加)。指紋のような同心弧のモチーフ
 * (「本人固有の実行パターン」を象徴)。 */
export function PemIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3a9 9 0 0 1 9 9" />
      <path d="M12 7a5 5 0 0 1 5 5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 21a9 9 0 0 1-9-9" />
    </svg>
  );
}

/** UI-10 週次レビューナビ用(2026-08-23追加)。折れ線グラフのモチーフ(振り返り)。 */
export function ReviewIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M7 15l3.5-4 3 2.5L18 8" />
    </svg>
  );
}
