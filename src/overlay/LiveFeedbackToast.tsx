import { motion, AnimatePresence } from "framer-motion";
import { useLiveFeedback } from "../hooks/useLiveFeedback";
import { useOverlayRuntimeNotice } from "../hooks/useOverlayRuntimeNotice";
import { C } from "../design/tokens";

const KIND_COLOR: Record<string, string> = {
  positive: "#00f5a0",
  tip:      "#ffd700",
  warning:  "#ff4d4d",
};

const KIND_ICON: Record<string, string> = {
  positive: "✓",
  tip:      "◆",
  warning:  "⚠",
};

interface LiveFeedbackToastProps {
  ttsEnabled?: boolean;
  ttsVoice?: string | null;
}

export function LiveFeedbackToast({ ttsEnabled = false, ttsVoice = null }: LiveFeedbackToastProps) {
  const toasts = useLiveFeedback(ttsEnabled, ttsVoice);
  const runtimeNotice = useOverlayRuntimeNotice();

  return (
    <div
      style={{
        display:        "flex",
        flexDirection:  "column-reverse",
        gap:            6,
        fontFamily:     "'JetBrains Mono', monospace",
        width:          300,
        pointerEvents:  "none",
      }}
    >
      {runtimeNotice.visible && (
        <div
          style={{
            background: C.glassDark,
            border: "1px solid #ff9f4330",
            borderLeft: "4px solid #ff9f43",
            borderRadius: 8,
            padding: "10px 13px",
            boxShadow: "0 4px 18px rgba(0,0,0,0.55), 0 0 10px rgba(255,159,67,0.12)",
          }}
        >
          <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
            <span
              style={{
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: "rgba(255,159,67,0.14)",
                border: "1px solid rgba(255,159,67,0.28)",
                color: "#ff9f43",
                fontSize: 9,
                fontWeight: 700,
                marginTop: 1,
                textShadow: "0 0 6px rgba(255,159,67,0.55)",
              }}
            >
              ⚠
            </span>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span
                style={{
                  color: "#ffcf99",
                  fontSize: 10,
                  lineHeight: 1.2,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                {runtimeNotice.title}
              </span>
              <span style={{ color: "rgba(255,255,255,0.88)", fontSize: 11, lineHeight: 1.45 }}>
                {runtimeNotice.message}
              </span>
            </div>
          </div>
        </div>
      )}

      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const color = KIND_COLOR[toast.kind] ?? "#ffffff";
          const icon  = KIND_ICON[toast.kind]  ?? "•";

          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 30, scale: 0.94 }}
              animate={{ opacity: 1, x: 0,  scale: 1 }}
              exit={{    opacity: 0, x: 30, scale: 0.9 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{
                background:     C.glassDark,
                border:         `1px solid ${color}30`,
                borderLeft:     `4px solid ${color}`,
                borderRadius:   8,
                padding:        "9px 13px",
                boxShadow:      `0 4px 18px rgba(0,0,0,0.55), 0 0 10px ${color}14`,
              }}
            >
              <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                {/* Icon pill */}
                <span
                  style={{
                    flexShrink:    0,
                    display:       "inline-flex",
                    alignItems:    "center",
                    justifyContent: "center",
                    width:         18,
                    height:        18,
                    borderRadius:  "50%",
                    background:    `${color}18`,
                    border:        `1px solid ${color}35`,
                    color,
                    fontSize:      9,
                    fontWeight:    700,
                    marginTop:     1,
                    textShadow:    `0 0 6px ${color}`,
                  }}
                >
                  {icon}
                </span>

                <span style={{ color: "rgba(255,255,255,0.88)", fontSize: 11, lineHeight: 1.45 }}>
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
