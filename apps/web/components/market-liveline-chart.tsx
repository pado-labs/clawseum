"use client";

import { useMemo } from "react";
import { Liveline, type LivelinePoint } from "liveline";

interface Props {
  className?: string;
  series: number[];
  color?: string;
}

export default function MarketLivelineChart({ className, series, color = "#d91f3f" }: Props) {
  const points = useMemo<LivelinePoint[]>(() => {
    const normalized = normalizeSeries(series);
    const now = Math.floor(Date.now() / 1000);

    return normalized.map((value, index) => ({
      time: now - (normalized.length - 1 - index) * 60,
      value: Math.round(value * 1000) / 10,
    }));
  }, [series]);

  const value = points[points.length - 1]?.value ?? 50;
  const windowSecs = Math.max(300, points.length * 60);

  return (
    <div className={className}>
      <Liveline
        data={points}
        value={value}
        color={color}
        theme="light"
        window={windowSecs}
        grid
        fill
        pulse={false}
        badge={false}
        scrub
        exaggerate
        formatValue={(v) => `${v.toFixed(1)}%`}
      />
    </div>
  );
}

function normalizeSeries(input: number[]): number[] {
  if (input.length === 0) return [0.5, 0.5];
  if (input.length === 1) {
    const value = normalizePoint(input[0] ?? 0.5);
    return [value, value];
  }
  return input.map((value) => normalizePoint(value));
}

function normalizePoint(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  if (v > 1) return clamp01(v / 100);
  return clamp01(v);
}

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(0.99, v));
}
