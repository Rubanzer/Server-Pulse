import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Server Pulse",
    short_name: "Pulse",
    description: "Live vitals and a year of history for your Ubuntu server.",
    start_url: "/",
    display: "standalone",
    background_color: "#eef2f6",
    theme_color: "#2457d6",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
