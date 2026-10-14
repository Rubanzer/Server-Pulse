"use client";

import { useState } from "react";

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre
        className="overflow-x-auto rounded-lg border border-line bg-code p-4 pr-20 font-mono text-[0.78125rem] leading-relaxed text-[#dbe6f5]"
        aria-label={label}
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 rounded-md bg-[#1b2a40] px-2.5 py-1 text-xs text-white shadow-[-12px_0_12px_var(--color-code)] ring-1 ring-[#3a4d6b] hover:bg-[#25374f] focus-visible:outline-white"
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
