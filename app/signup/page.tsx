import { SignupForm } from "@/components/auth-forms";
import { signupOpen } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default function SignupPage() {
  const open = signupOpen();
  return <SignupForm open={open} reason={open ? null : !db ? "nodb" : "closed"} />;
}
