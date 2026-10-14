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

export function Nav({
  role,
  email,
}: {
  role: Role | null;
  email: string | null;
}) {
  const path = usePathname();
  const links = role
    ? [
        { href: "/", label: "Live" },
        { href: "/server", label: "Server" },
        { href: "/history", label: "History" },
        { href: "/reports", label: "Reports" },
        ...(role === "owner"
          ? [
              { href: "/logs", label: "Logs" },
              { href: "/connect", label: "Add server" },
              { href: "/settings", label: "Settings" },
            ]
          : []),
      ]
    : [
        { href: "/login", label: "Log in" },
        { href: "/signup", label: "Create account" },
      ];

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    hardNavigate("/login");
  }

  const nav = (
    <nav
      className="no-scrollbar -mx-1 -my-1 flex items-center gap-1 overflow-x-auto py-1 text-sm max-lg:pr-6 max-lg:[mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]"
      aria-label="Main"
    >
      {links.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            prefetch // full prefetch: every page is ready before it's clicked
            aria-current={active ? "page" : undefined}
            // phones: the nav row scrolls; keep the current page's tab in view
            ref={
              active
                ? (el) =>
                    el?.scrollIntoView({ inline: "nearest", block: "nearest" })
                : undefined
            }
            className={`relative inline-flex items-center whitespace-nowrap rounded-md px-2.5 py-1.5 transition-colors ${active ? "bg-paper font-medium text-ink" : "text-muted hover:text-ink"}`}
          >
            {l.label}
            <Pending />
          </Link>
        );
      })}
    </nav>
  );

  return (
    <header className="sticky top-0 z-40 [@media(max-height:30rem)]:static border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 2xl:max-w-[100rem] min-[2200px]:max-w-[140rem]">
        <div className="flex h-14 items-center gap-2 sm:gap-4">
          <Link
            href="/"
            prefetch
            className="logo-ring shrink-0"
            aria-label="Server Pulse, live overview"
          >
            <span className="logo-inner flex items-center gap-2 px-3 py-1 font-semibold tracking-tight max-[399px]:px-2">
              <svg
                aria-hidden
                viewBox="0 0 32 32"
                className="size-6 text-signal"
              >
                <path
                  className="logo-pulse"
                  d="M2 17h7l3-8 5 15 4-11 2 4h7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {/* phones under 400 px: icon only, so the bar (logo, four theme choices, Log out) never overflows */}
              <span className="max-[399px]:sr-only">Server Pulse</span>
            </span>
          </Link>
          {/* wide screens: links inline */}
          <div className="hidden min-w-0 flex-1 lg:block">{nav}</div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {email && (
              <span
                className="hidden max-w-[14rem] truncate text-sm text-muted xl:inline"
                title={email}
              >
                {email}
              </span>
            )}
            <ThemeToggle />
            {role && (
              <button
                onClick={logout}
                className="rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-paper hover:text-ink"
              >
                Log out
              </button>
            )}
          </div>
        </div>
        {/* phones and tablets: links get their own scrollable row */}
        <div className="pb-2 lg:hidden">{nav}</div>
      </div>
    </header>
  );
}
