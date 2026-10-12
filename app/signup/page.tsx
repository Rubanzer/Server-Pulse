import { SignupForm } from "@/components/auth-forms";
import { signupOpen } from "@/lib/auth";

export const metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default function SignupPage() {
  return <SignupForm open={signupOpen()} />;
}
