import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

// [AUTH-EMAIL-01新設・2026-09-26] URLにtokenを含むため、Refererで外部へ送らない。
export const metadata: Metadata = { title: "新しいパスワードの設定 | ISMAY", referrer: "no-referrer" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={typeof token === "string" ? token : ""} />;
}
