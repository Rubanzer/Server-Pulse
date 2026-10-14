import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import { cookies } from "next/headers";
import { BackfillRunner } from "@/components/backfill-runner";
import { Nav } from "@/components/nav";
import { THEME_SCRIPT } from "@/components/theme-toggle";
import { COOKIE, verifySession } from "@/lib/session";
import "./globals.css";

const plex = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex" });
const plexCond = IBM_Plex_Sans_Condensed({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-plex-cond" });

export const metadata: Metadata = {
  title: { default: "Server Pulse", template: "%s · Server Pulse" },
  description: "Live vitals and a year of history for your Ubuntu server.",
  appleWebApp: { capable: true, title: "Server Pulse", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef2f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1828" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const s = await verifySession((await cookies()).get(COOKIE)?.value);
  return (
    // data-theme is set by THEME_SCRIPT before hydration, so React must not complain about it
    <html lang="en" className={`${plex.variable} ${plexCond.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <Nav role={s?.role ?? null} email={s?.email ?? null} />
        <main className="mx-auto w-full max-w-6xl min-w-0 px-4 pb-[max(4rem,env(safe-area-inset-bottom))] pt-4 sm:px-6 2xl:max-w-[100rem]">
          {children}
        </main>
        {s?.role === "owner" && <BackfillRunner />}
        <script
          dangerouslySetInnerHTML={{
            __html: `if("serviceWorker" in navigator&&location.protocol==="https:")navigator.serviceWorker.register("/sw.js")`,
          }}
        />
      </body>
    </html>
  );
}
