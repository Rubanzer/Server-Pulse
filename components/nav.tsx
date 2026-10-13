"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { hardNavigate } from "@/lib/navigate";
import type { Role } from "@/lib/session";
import { ThemeToggle } from "./theme-toggle";

/** Thin bar under a link whose page is still loading (only visible if it wasn't prefetched yet). */
function Pending() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`absolute inset-x-2 -bottom-px h-0.5 origin-left rounded bg-signal transition-transform duration-500 ${pending ? "scale-x-100" : "scale-x-0"}`}
    />
  );
}

export function Nav({ role, email }: { role: Role | null; email: string | null }) {
  const path = usePathname();
  const links = role
    ? [
        { href: "/", label: "Live" },
        { href: "/server", label: "Server" },
        { href: "/history", label: "History" },
        { href: "/reports", label: "Reports" },
        ...(role === "owner"
          ? [
              { href: "/connect", label: "Add server" },
              { href: "/settings", label: "Settings" },
            ]
          : []),
      ]
    : [
        { href: "/login", label: "Log in" },
        { href: "/signup", label: "Create account" },
        { href: "/setup", label: "Server setup" },
      ];

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    hardNavigate("/login");
  }

  const nav = (
    <nav className="no-scrollbar -mx-1 flex items-center gap-1 overflow-x-auto text-sm" aria-label="Main">
      {links.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            prefetch // full prefetch: every page is ready before it's clicked
            aria-current={active ? "page" : undefined}
            className={`relative whitespace-nowrap rounded-md px-2.5 py-1.5 transition-colors ${active ? "bg-paper font-medium text-ink" : "text-muted hover:text-ink"}`}
          >
            {l.label}
            <Pending />
          </Link>
        );
      })}
    </nav>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/90 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 2xl:max-w-[1600px]">
        <div className="flex h-14 items-center gap-4">
          <Link href="/" prefetch className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
            <svg aria-hidden viewBox="0 0 32 32" className="size-6 text-signal">
              <path d="M2 17h7l3-8 5 15 4-11 2 4h7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Server Pulse
          </Link>
          {/* wide screens: links inline */}
          <div className="hidden min-w-0 flex-1 md:block">{nav}</div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {email && (
              <span className="hidden max-w-[16rem] truncate text-sm text-muted lg:inline" title={email}>
                {email}
              </span>
            )}
            <ThemeToggle />
            {role && (
              <button onClick={logout} className="rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-paper hover:text-ink">
                Log out
              </button>
            )}
          </div>
        </div>
        {/* phones and tablets: links get their own scrollable row */}
        <div className="pb-2 md:hidden">{nav}</div>
      </div>
    </header>
  );
}
