import { motion, AnimatePresence } from "framer-motion";
import { useLiveFeedback } from "../hooks/useLiveFeedback";

const KIND_COLOR: Record<string, string> = {
  positive: "#00f5a0",
  tip: "#ffd700",
  warning: "#ff4d4d",
};

const KIND_ICON: Record<string, string> = {
  positive: "✓",
  tip: "◆",
  warning: "⚠",
};

interface LiveFeedbackToastProps {
  ttsEnabled?: boolean;
  ttsVoice?: string | null;
}

/**
 * Auto-dismissing coaching notification stack.
 * Positioning is handled by the parent DraggableHUD wrapper.
 */
export function LiveFeedbackToast({ ttsEnabled = false, ttsVoice = null }: LiveFeedbackToastProps) {
  const toasts = useLiveFeedback(ttsEnabled, ttsVoice);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column-reverse",
        gap: 8,
        fontFamily: "'JetBrains Mono', monospace",
        width: 280,
        pointerEvents: "none",
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const color = KIND_COLOR[toast.kind] ?? "#ffffff";
          const icon = KIND_ICON[toast.kind] ?? "•";
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 40, scale: 0.92 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.88 }}
              transition={{ duration: 0.2 }}
              style={{
                background: "rgba(8, 8, 14, 0.88)",
                border: `1px solid ${color}44`,
                borderLeft: `3px solid ${color}`,
                borderRadius: 6,
                padding: "7px 12px",
                maxWidth: 300,
                backdropFilter: "blur(10px)",
                boxShadow: `0 2px 12px rgba(0,0,0,0.5), 0 0 8px ${color}18`,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span
                  style={{
                    color,
                    fontSize: 11,
                    fontWeight: 700,
                    marginTop: 1,
                    flexShrink: 0,
                    textShadow: `0 0 6px ${color}`,
                  }}
                >
                  {icon}
                </span>
                <span
                  style={{
                    color: "rgba(255,255,255,0.88)",
                    fontSize: 11,
                    lineHeight: 1.4,
                  }}
                >
                  {toast.message}
                </span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
