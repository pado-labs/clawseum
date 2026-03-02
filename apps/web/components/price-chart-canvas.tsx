"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface ChartLine {
  values: number[];
  color: string;
  width?: number;
}

interface Props {
  className?: string;
  lines: ChartLine[];
  min?: number;
  max?: number;
}

export default function PriceChartCanvas({ className, lines, min = 0, max = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const normalizedLines = useMemo(() => {
    return lines
      .map((line) => ({
        ...line,
        values: normalizeValues(line.values),
      }))
      .filter((line) => line.values.length >= 2);
  }, [lines]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    drawGrid(ctx, size.width, size.height);

    for (const line of normalizedLines) {
      drawLine(ctx, size.width, size.height, line.values, line.color, line.width ?? 2, min, max);
    }
  }, [normalizedLines, size, min, max]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

function normalizeValues(values: number[]): number[] {
  if (values.length === 0) return [0.5, 0.5];
  if (values.length === 1) return [values[0] ?? 0.5, values[0] ?? 0.5];
  return values;
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const rows = 4;
  ctx.save();
  ctx.strokeStyle = "rgba(198, 151, 157, 0.32)";
  ctx.lineWidth = 1;
  for (let i = 1; i < rows; i += 1) {
    const y = (height / rows) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  values: number[],
  color: string,
  lineWidth: number,
  min: number,
  max: number
): void {
  if (values.length < 2) return;

  const range = Math.max(1e-6, max - min);
  const stepX = width / (values.length - 1);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  for (let i = 0; i < values.length; i += 1) {
    const raw = values[i] ?? min;
    const normalized = Math.max(0, Math.min(1, (raw - min) / range));
    const x = i * stepX;
    const y = height - normalized * height;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}
