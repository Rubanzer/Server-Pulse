"use client";

import { useState } from "react";

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre
        className="overflow-x-auto rounded-lg border border-line bg-[#0f1b2d] p-4 pr-20 font-mono text-[12.5px] leading-relaxed text-[#dbe6f5]"
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
        className="absolute right-2 top-2 rounded-md bg-white/10 px-2.5 py-1 text-xs text-white hover:bg-white/20"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
