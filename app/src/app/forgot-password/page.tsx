import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = { title: "パスワードの再設定 | ISMAY" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
