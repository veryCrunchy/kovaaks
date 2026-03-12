import { C, accentAlpha } from "../design/tokens";

export interface ShortcutHelpItem {
  keys: string;
  action: string;
  detail?: string;
}

export interface ShortcutHelpGroup {
  title: string;
  items: ShortcutHelpItem[];
}

interface ShortcutHelpModalProps {
  open: boolean;
  title: string;
  groups: ShortcutHelpGroup[];
  note?: string;
  onClose: () => void;
}

export function ShortcutHelpModal({
  open,
  title,
  groups,
  note,
  onClose,
}: ShortcutHelpModalProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(5, 8, 14, 0.72)",
        backdropFilter: "blur(10px)",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "min(680px, 92vw)",
          maxHeight: "80vh",
          overflowY: "auto",
          background: "rgba(9, 12, 20, 0.96)",
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          boxShadow: "0 22px 80px rgba(0,0,0,0.55)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "18px 20px 14px",
            borderBottom: `1px solid ${C.borderSub}`,
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: C.accent, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>
              Help
            </div>
            <div style={{ marginTop: 4, fontSize: 16, color: C.text, fontWeight: 700 }}>
              {title}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.05)",
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              color: C.textMuted,
              cursor: "pointer",
              padding: "6px 10px",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            Esc
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, padding: 20 }}>
          {groups.map((group) => (
            <div
              key={group.title}
              style={{
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${C.borderSub}`,
                borderRadius: 12,
                padding: "14px 14px 12px",
              }}
            >
              <div style={{ marginBottom: 10, color: C.text, fontSize: 12, fontWeight: 700 }}>
                {group.title}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {group.items.map((item) => (
                  <div key={`${group.title}:${item.keys}:${item.action}`} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10, alignItems: "start" }}>
                    <span
                      style={{
                        fontSize: 11,
                        color: C.accent,
                        background: accentAlpha("14"),
                        border: `1px solid ${C.accentBorder}`,
                        borderRadius: 999,
                        padding: "4px 8px",
                        textAlign: "center",
                        fontWeight: 700,
                      }}
                    >
                      {item.keys}
                    </span>
                    <div>
                      <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.45 }}>
                        {item.action}
                      </div>
                      {item.detail && (
                        <div style={{ marginTop: 3, fontSize: 11, color: C.textFaint, lineHeight: 1.45 }}>
                          {item.detail}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {note && (
          <div
            style={{
              padding: "0 20px 18px",
              color: C.textFaint,
              fontSize: 11,
              lineHeight: 1.6,
            }}
          >
            {note}
          </div>
        )}
      </div>
    </div>
  );
}
