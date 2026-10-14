import { redirect } from "next/navigation";

// The old step-by-step server kit is retired: one install command on Add server does it all.
export default function SetupPage() {
  redirect("/connect");
}
