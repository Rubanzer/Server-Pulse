import { LoginForm } from "@/components/auth-forms";
import { db } from "@/lib/db";
import { demoAuth, ownerPassword } from "@/lib/session";

export const metadata = { title: "Log in" };
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <LoginForm accounts={!!db} shared={!!ownerPassword() || !!process.env.VIEWER_PASSWORD} demo={demoAuth()} />;
}
