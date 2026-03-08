import type { CSSProperties, ElementType, ReactNode } from "react";
import { C } from "./tokens";

// ─── GlassCard ─────────────────────────────────────────────────────────────────
// Frosted-glass container. Optional `accent` tints the border and adds a glow.

interface GlassCardProps {
  children: ReactNode;
  accent?: string;
  className?: string;
  style?: CSSProperties;
  as?: ElementType;
}

export function GlassCard({ children, accent, className = "", style, as: Tag = "div" }: GlassCardProps) {
  const border  = accent ? `${accent}22` : C.border;
  const shadow  = accent
    ? `0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px ${accent}0a, inset 0 1px 0 rgba(255,255,255,0.06)`
    : `0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)`;

  return (
    <Tag
      className={className}
      style={{
        background:     C.glass,
        border:         `1px solid ${border}`,
        borderRadius:   12,
        backdropFilter: "blur(16px) saturate(180%)",
        boxShadow:      shadow,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

// ─── Badge ─────────────────────────────────────────────────────────────────────
// Small coloured pill — used for scenario types, status labels, etc.

interface BadgeProps {
  color: string;
  children: ReactNode;
  size?: "xs" | "sm";
  className?: string;
}

export function Badge({ color, children, size = "sm", className = "" }: BadgeProps) {
  const fontSize  = size === "xs" ? 8  : 9;
  const padding   = size === "xs" ? "1px 5px" : "2px 7px";

  return (
    <span
      className={className}
      style={{
        display:        "inline-flex",
        alignItems:     "center",
        fontSize,
        fontWeight:     700,
        letterSpacing:  "0.08em",
        textTransform:  "uppercase",
        padding,
        borderRadius:   99,
        background:     `${color}18`,
        border:         `1px solid ${color}35`,
        color,
        lineHeight:     1.3,
        whiteSpace:     "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// ─── Dot ───────────────────────────────────────────────────────────────────────
// Simple status indicator dot.

interface DotProps {
  color: string;
  pulse?: boolean;
  size?: number;
  className?: string;
}

export function Dot({ color, pulse = false, size = 7, className = "" }: DotProps) {
  return (
    <span
      className={`${pulse ? "animate-glow-pulse" : ""} ${className}`}
      style={{
        display:      "inline-block",
        width:        size,
        height:       size,
        borderRadius: "50%",
        background:   color,
        boxShadow:    `0 0 6px ${color}`,
        flexShrink:   0,
      }}
    />
  );
}

// ─── StatRow ───────────────────────────────────────────────────────────────────
// Label/value pair in a horizontal row.

interface StatRowProps {
  label: string;
  value: string;
  accent?: string;
  highlight?: boolean;
  className?: string;
}

export function StatRow({ label, value, accent, highlight = false, className = "" }: StatRowProps) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${className}`}>
      <span
        style={{
          fontSize:      9,
          fontWeight:    600,
          letterSpacing: "0.1em",
          textTransform: "uppercase" as const,
          color:         C.textMuted,
          whiteSpace:    "nowrap",
        }}
      >
        {label}
      </span>
      <span
        className="tabular-nums"
        style={{
          fontSize:   highlight ? 15 : 12,
          fontWeight: highlight ? 700 : 500,
          color:      highlight && accent ? accent : C.text,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── MiniBar ───────────────────────────────────────────────────────────────────
// Thin animated progress bar.

interface MiniBarProps {
  pct: number;
  color?: string;
  height?: number;
  className?: string;
  label?: string;
  value?: string;
}

export function MiniBar({ pct, color = C.accent, height = 3, className = "", label, value }: MiniBarProps) {
  const clamped = Math.min(100, Math.max(0, pct));

  return (
    <div className={className}>
      {(label || value) && (
        <div className="flex items-center justify-between mb-0.5">
          {label && (
            <span style={{ fontSize: 8, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textFaint }}>
              {label}
            </span>
          )}
          {value && (
            <span style={{ fontSize: 9, fontWeight: 600, color: C.textMuted }}>
              {value}
            </span>
          )}
        </div>
      )}
      <div
        style={{
          height,
          borderRadius: height,
          background:   "rgba(255,255,255,0.07)",
          overflow:     "hidden",
        }}
      >
        <div
          style={{
            height:     "100%",
            width:      `${clamped}%`,
            borderRadius: height,
            background:   `linear-gradient(90deg, ${color}70, ${color})`,
            transition:   "width 0.5s ease",
          }}
        />
      </div>
    </div>
  );
}

// ─── Toggle ────────────────────────────────────────────────────────────────────
// Accessible toggle switch — no JS hover handlers needed.

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, disabled = false, className = "" }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative shrink-0 rounded-full outline-none ${className}`}
      style={{
        width:      40,
        height:     22,
        background: checked ? C.accent : "rgba(255,255,255,0.14)",
        border:     "none",
        cursor:     disabled ? "not-allowed" : "pointer",
        transition: "background 0.2s ease",
        padding:    0,
        opacity:    disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position:    "absolute",
          width:       16,
          height:      16,
          borderRadius: "50%",
          top:         3,
          left:        checked ? 21 : 3,
          background:  "#ffffff",
          boxShadow:   "0 1px 4px rgba(0,0,0,0.45)",
          transition:  "left 0.2s ease",
          display:     "block",
        }}
      />
    </button>
  );
}

// ─── Btn ───────────────────────────────────────────────────────────────────────
// Button with multiple variants. Hover is CSS-driven (see index.css .am-btn-*).

type BtnVariant = "primary" | "ghost" | "danger" | "accent";
type BtnSize    = "xs" | "sm" | "md";

interface BtnProps {
  variant?: BtnVariant;
  size?: BtnSize;
  children: ReactNode;
  onClick?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  type?: "button" | "submit" | "reset";
}

const BTN_SIZE: Record<BtnSize, string> = {
  xs: "px-2.5 py-1 text-[10px]",
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export function Btn({
  variant = "ghost",
  size = "sm",
  children,
  onClick,
  onBlur,
  disabled,
  className = "",
  style,
  title,
  type = "button",
}: BtnProps) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      onBlur={onBlur}
      className={`am-btn am-btn-${variant} rounded-lg font-semibold tabular-nums ${BTN_SIZE[size]} ${className}`}
      style={style}
    >
      {children}
    </button>
  );
}

// ─── FieldGroup ────────────────────────────────────────────────────────────────
// Settings form group: label, optional description, then children.

interface FieldGroupProps {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function FieldGroup({ label, description, children, className = "" }: FieldGroupProps) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div>
        <span className="text-sm font-semibold" style={{ color: C.textSub }}>
          {label}
        </span>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed" style={{ color: C.textFaint }}>
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── SectionLabel ──────────────────────────────────────────────────────────────
// Small uppercase section header with optional divider line.

interface SectionLabelProps {
  children: ReactNode;
  className?: string;
}

export function SectionLabel({ children, className = "" }: SectionLabelProps) {
  return (
    <div
      className={`flex items-center gap-2 ${className}`}
      style={{ marginBottom: 4 }}
    >
      <span
        style={{
          fontSize:      9,
          fontWeight:    700,
          letterSpacing: "0.12em",
          textTransform: "uppercase" as const,
          color:         C.textFaint,
          whiteSpace:    "nowrap",
        }}
      >
        {children}
      </span>
      <div style={{ flex: 1, height: 1, background: C.borderSub }} />
    </div>
  );
}
