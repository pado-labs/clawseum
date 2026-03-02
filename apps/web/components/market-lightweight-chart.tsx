"use client";

import { useMemo } from "react";
import { AreaSeries, Chart, LineSeries } from "lightweight-charts-react-wrapper";
import { ColorType, type UTCTimestamp } from "lightweight-charts";

interface Point {
  t: number;
  yes: number;
  no: number;
}

interface Props {
  className?: string;
  points: Point[];
}

export default function MarketLightweightChart({ className, points }: Props) {
  const normalized = useMemo(() => normalizePoints(points), [points]);

  return (
    <div className={className}>
      <Chart
        autoSize
        height={258}
        layout={{
          background: { type: ColorType.Solid, color: "#fff9fa" },
          textColor: "#8b6970",
          attributionLogo: true,
        }}
        rightPriceScale={{
          borderColor: "#f0d5da",
          scaleMargins: { top: 0.12, bottom: 0.12 },
        }}
        timeScale={{
          borderColor: "#f0d5da",
          fixLeftEdge: true,
          fixRightEdge: true,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 2,
        }}
        grid={{
          vertLines: { color: "#f9e8eb" },
          horzLines: { color: "#f4dce1" },
        }}
        crosshair={{
          vertLine: { color: "#dc2a49", width: 1, labelBackgroundColor: "#dc2a49" },
          horzLine: { color: "#e57688", width: 1, labelBackgroundColor: "#e57688" },
        }}
      >
        <AreaSeries
          data={normalized.yes}
          lineColor="#d9203f"
          lineWidth={2}
          topColor="rgba(217, 32, 63, 0.28)"
          bottomColor="rgba(217, 32, 63, 0.06)"
          priceLineVisible
          lastValueVisible
        />
        <LineSeries
          data={normalized.no}
          color="#7f5861"
          lineWidth={2}
          priceLineVisible={false}
          lastValueVisible={false}
        />
      </Chart>
    </div>
  );
}

function normalizePoints(input: Point[]): {
  yes: Array<{ time: UTCTimestamp; value: number }>;
  no: Array<{ time: UTCTimestamp; value: number }>;
} {
  if (input.length === 0) {
    const now = Math.floor(Date.now() / 1000) as UTCTimestamp;
    return {
      yes: [{ time: now, value: 50 }],
      no: [{ time: now, value: 50 }],
    };
  }

  return {
    yes: input.map((point) => ({
      time: toUtcSecond(point.t),
      value: normalizePercent(point.yes),
    })),
    no: input.map((point) => ({
      time: toUtcSecond(point.t),
      value: normalizePercent(point.no),
    })),
  };
}

function toUtcSecond(timestampMs: number): UTCTimestamp {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return Math.floor(Date.now() / 1000) as UTCTimestamp;
  }
  return Math.floor(timestampMs / 1000) as UTCTimestamp;
}

function normalizePercent(v: number): number {
  if (!Number.isFinite(v)) return 50;
  if (v > 1) return clamp(v, 1, 99);
  return clamp(v * 100, 1, 99);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
