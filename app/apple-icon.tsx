import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iPhone home-screen icon (iOS ignores SVG icons). */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#2457d6" }}>
        <svg viewBox="0 0 64 64" width="180" height="180">
          <path d="M8 35h12l6-15 10 29 8-21 4 7h8" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    size,
  );
}
