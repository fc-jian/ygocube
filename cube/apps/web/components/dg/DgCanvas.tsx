'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import {
  DG_BRUSH_WIDTHS, DG_HEIGHT, DG_MAX_POINTS, DG_MAX_STROKES, DG_WIDTH,
  type DgBrushWidth, type DgDrawing, type DgPoint, type DgStroke,
} from '@ygocube/shared';
import { useGuessPolling } from '@/components/guess/guess-client';
import type { GuessText } from '@/components/guess/guess-text';
import { dgRequest } from './dg-client';
import type { DgText } from './dg-text';

function ink(context: CanvasRenderingContext2D, stroke: DgStroke, point: DgPoint, previous?: DgPoint) {
  context.beginPath();
  if (previous) {
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = 'round';
    context.moveTo(...previous);
    context.lineTo(...point);
    context.stroke();
  } else {
    context.fillStyle = stroke.color;
    context.arc(...point, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
  }
}

function paint(canvas: HTMLCanvasElement | null, strokes: readonly DgStroke[]) {
  const context = canvas?.getContext('2d');
  if (!context) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, DG_WIDTH, DG_HEIGHT);
  for (const stroke of strokes) {
    stroke.points.forEach((point, index) => ink(context, stroke, point, stroke.points[index - 1]));
  }
}

function pointAt(event: PointerEvent<HTMLCanvasElement>): DgPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return [
    Math.round(Math.min(DG_WIDTH, Math.max(0, (event.clientX - rect.left) * DG_WIDTH / rect.width))),
    Math.round(Math.min(DG_HEIGHT, Math.max(0, (event.clientY - rect.top) * DG_HEIGHT / rect.height))),
  ];
}

export function DgSketch({ text, disabled, submit, submitLabel = text.submitDrawing }: {
  text: DgText;
  disabled: boolean;
  submit: (drawing: DgDrawing) => void;
  submitLabel?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<DgStroke[]>([]);
  const pointCount = useRef(0);
  const pointerId = useRef<number | null>(null);
  const [strokeCount, setStrokeCount] = useState(0);
  const [atLimit, setAtLimit] = useState(false);
  const [color, setColor] = useState('#17212b');
  const [width, setWidth] = useState<DgBrushWidth>(5);
  const [eraser, setEraser] = useState(false);
  useEffect(() => paint(canvas.current, strokes.current), []);

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (disabled || pointerId.current !== null || event.button !== 0) return;
    if (strokes.current.length >= DG_MAX_STROKES || pointCount.current >= DG_MAX_POINTS) {
      setAtLimit(true);
      return;
    }
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerId.current = event.pointerId;
    const point = pointAt(event);
    const stroke = { color: eraser ? '#ffffff' : color, width, points: [point] };
    strokes.current.push(stroke);
    pointCount.current++;
    setStrokeCount(strokes.current.length);
    ink(context, stroke, point);
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (disabled || pointerId.current !== event.pointerId) return;
    if (pointCount.current >= DG_MAX_POINTS) {
      setAtLimit(true);
      return;
    }
    const stroke = strokes.current[strokes.current.length - 1];
    const previous = stroke.points[stroke.points.length - 1];
    const point = pointAt(event);
    if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 2) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    stroke.points.push(point);
    pointCount.current++;
    ink(context, stroke, point, previous);
  }

  function stop(event: PointerEvent<HTMLCanvasElement>) {
    if (pointerId.current === event.pointerId) pointerId.current = null;
  }

  function undo() {
    pointerId.current = null;
    pointCount.current -= strokes.current.pop()?.points.length ?? 0;
    setStrokeCount(strokes.current.length);
    setAtLimit(false);
    paint(canvas.current, strokes.current);
  }

  function clear() {
    pointerId.current = null;
    strokes.current = [];
    pointCount.current = 0;
    setStrokeCount(0);
    setAtLimit(false);
    paint(canvas.current, strokes.current);
  }

  return (
    <section className="guess-panel" aria-label={text.drawTitle}>
      <div className="dg-toolbar">
        <label className="dg-color">{text.brushColor}
          <input type="color" value={color} disabled={disabled} onChange={(event) => {
            setColor(event.target.value);
            setEraser(false);
          }} />
        </label>
        <label className="dg-width">{text.brushWidth}
          <select className="guess-input" value={width} disabled={disabled} onChange={(event) => {
            const size = DG_BRUSH_WIDTHS.find((value) => value === Number(event.target.value));
            if (size !== undefined) setWidth(size);
          }}>
            {DG_BRUSH_WIDTHS.map((value) => <option value={value} key={value}>{value} px</option>)}
          </select>
        </label>
        <button type="button" className={eraser ? 'guess-selected' : 'guess-secondary'} aria-pressed={eraser}
          disabled={disabled} onClick={() => setEraser(!eraser)}>{text.eraser}</button>
        <button type="button" className="guess-secondary" disabled={disabled || !strokeCount} onClick={undo}>{text.undo}</button>
        <button type="button" className="guess-secondary" disabled={disabled || !strokeCount} onClick={clear}>{text.clear}</button>
      </div>
      <canvas ref={canvas} className="dg-canvas dg-canvas-edit" width={DG_WIDTH} height={DG_HEIGHT}
        aria-label={text.drawingLabel} aria-disabled={disabled} onPointerDown={start} onPointerMove={move}
        onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} />
      {atLimit && <p role="status" className="guess-muted">{text.drawingLimit}</p>}
      <button type="button" className="guess-primary" disabled={disabled || !strokeCount}
        onClick={() => submit({ strokes: strokes.current })}>{submitLabel}</button>
    </section>
  );
}

export function DgPicture({ path, title, shared, token, children }: {
  path: string;
  title: string;
  shared: GuessText;
  token?: string;
  children?: ReactNode;
}) {
  const [drawing, setDrawing] = useState<DgDrawing | null>(null);
  const [error, setError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await dgRequest<DgDrawing>(path, { token, signal });
      if (!signal.aborted) setDrawing(data);
    } catch {
      if (!signal.aborted) setError(true);
    }
  }, [path, token]);
  useGuessPolling(drawing === null ? load : null, 1500);
  useEffect(() => {
    if (drawing) paint(canvas.current, drawing.strokes);
  }, [drawing]);

  return (
    <section className="guess-panel">
      <h2>{title}</h2>
      {children}
      {drawing
        ? <canvas ref={canvas} className="dg-canvas" width={DG_WIDTH} height={DG_HEIGHT} role="img" aria-label={title} />
        : <p className={error ? 'guess-error' : 'guess-muted'} role="status">{error ? shared.genericError : shared.loading}</p>}
    </section>
  );
}
