"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  AreaSeries,
  ColorType,
  LineSeries,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";

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
  const hostRef = useRef<HTMLDivElement | null>(null);

  const normalized = useMemo(() => normalizePoints(points), [points]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      width: Math.max(1, host.clientWidth),
      height: 258,
      layout: {
        background: { type: ColorType.Solid, color: "#fff9fa" },
        textColor: "#8b6970",
        attributionLogo: true,
      },
      rightPriceScale: {
        borderColor: "#f0d5da",
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: "#f0d5da",
        fixLeftEdge: true,
        fixRightEdge: true,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
      },
      grid: {
        vertLines: { color: "#f9e8eb" },
        horzLines: { color: "#f4dce1" },
      },
      crosshair: {
        vertLine: { color: "#dc2a49", width: 1, labelBackgroundColor: "#dc2a49" },
        horzLine: { color: "#e57688", width: 1, labelBackgroundColor: "#e57688" },
      },
    });

    const yesSeries = chart.addSeries(AreaSeries, {
      lineColor: "#d9203f",
      lineWidth: 2,
      topColor: "rgba(217, 32, 63, 0.28)",
      bottomColor: "rgba(217, 32, 63, 0.06)",
      priceLineVisible: true,
      lastValueVisible: true,
    });

    const noSeries = chart.addSeries(LineSeries, {
      color: "#7f5861",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    yesSeries.setData(normalized.yes);
    noSeries.setData(normalized.no);
    chart.timeScale().fitContent();

    const observer = new ResizeObserver(() => {
      const nextWidth = Math.max(1, host.clientWidth);
      chart.applyOptions({ width: nextWidth });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [normalized]);

  return <div ref={hostRef} className={className} />;
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

  const byTime = new Map<number, { yes: number; no: number }>();
  for (const point of input) {
    const t = toUtcSecond(point.t);
    byTime.set(t, {
      yes: normalizePercent(point.yes),
      no: normalizePercent(point.no),
    });
  }

  const orderedTimes = [...byTime.keys()].sort((a, b) => a - b);

  return {
    yes: orderedTimes.map((t) => ({
      time: t as UTCTimestamp,
      value: byTime.get(t)?.yes ?? 50,
    })),
    no: orderedTimes.map((t) => ({
      time: t as UTCTimestamp,
      value: byTime.get(t)?.no ?? 50,
    })),
  };
}

function toUtcSecond(timestampMs: number): number {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(timestampMs / 1000);
}

function normalizePercent(v: number): number {
  if (!Number.isFinite(v)) return 50;
  if (v > 1) return clamp(v, 1, 99);
  return clamp(v * 100, 1, 99);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
