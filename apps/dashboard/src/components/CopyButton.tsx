import { useState } from "react";
import { Icon } from "./Icon";
import { useToast } from "./Toast";

/** Copies text to the clipboard and says so. Falls back to selecting nothing if the browser refuses. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.show("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" onClick={() => void copy()} aria-live="polite">
      <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : label}
    </button>
  );
}
