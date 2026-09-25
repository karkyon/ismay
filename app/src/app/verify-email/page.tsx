import type { Metadata } from "next";
import { EmailVerifyForm } from "@/components/auth/EmailVerifyForm";

// [AUTH-EMAIL-01新設・2026-09-26] URLにtokenを含むため、Refererで外部へ送らない。
export const metadata: Metadata = { title: "メールアドレスの確認 | ISMAY", referrer: "no-referrer" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <EmailVerifyForm token={typeof token === "string" ? token : ""} />;
}
