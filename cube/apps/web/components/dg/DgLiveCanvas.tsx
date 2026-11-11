'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyDgDrawingPatch, DG_HEIGHT, DG_WIDTH,
  type DgDrawing, type DgDrawingPatch, type DgDrawingPosition, type DgLiveDrawing, type DgStroke,
} from '@ygocube/shared';
import { useGuessPolling } from '@/components/guess/guess-client';
import { API_BASE, ApiError } from '@/lib/api';
import { DgSketch, paintDgDrawing } from './DgCanvas';
import { DG_PATH, dgRequest } from './dg-client';
import type { DgText } from './dg-text';

const SEND_INTERVAL_MS = 125;
const RETRY_INTERVAL_MS = 500;

type SketchProps = {
  path: string;
  token: string;
  text: DgText;
  disabled: boolean;
  submit: (drawing: DgDrawing) => void;
};

export function DgLiveSketch(props: SketchProps) {
  const { path, text } = props;
  const [initial, setInitial] = useState<DgLiveDrawing | null>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const snapshot = await dgRequest<DgLiveDrawing>(`${path}/live`, { signal });
      if (!signal.aborted) setInitial(snapshot);
    } catch {
      // Retry on the next poll while the room is still drawing.
    }
  }, [path]);
  useGuessPolling(initial === null ? load : null, 500);
  const resync = useCallback(() => setInitial(null), []);

  if (!initial) return <section className="guess-panel"><p className="guess-muted" role="status">{text.drawingSync}</p></section>;
  return <LiveSketchEditor {...props} initial={initial} resync={resync} />;
}

function LiveSketchEditor({ path, token, text, disabled, submit, initial, resync }: SketchProps & {
  initial: DgLiveDrawing;
  resync: () => void;
}) {
  const onEdit = useRef<(strokes: DgStroke[], from: DgDrawingPosition) => void>(() => {});
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let revision = initial.revision;
    let latest: DgStroke[] = initial.strokes;
    let pending: DgDrawingPosition | null = null;
    let retry: DgDrawingPatch | null = null;
    let inFlight = false;
    let ended = false;
    let timer: number | undefined;

    function schedule(delay: number) {
      if (ended || controller.signal.aborted || inFlight || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void send();
      }, delay);
    }

    async function send() {
      if (!retry && pending) {
        const { strokeIndex, pointIndex } = pending;
        retry = {
          baseRevision: revision, revision: crypto.randomUUID(), strokeIndex, pointIndex,
          strokes: latest.slice(strokeIndex).map((stroke, index) => ({
            ...stroke, points: stroke.points.slice(index === 0 ? pointIndex : 0),
          })),
        };
        pending = null;
      }
      if (!retry) return;
      inFlight = true;
      let delay = SEND_INTERVAL_MS;
      try {
        const result = await dgRequest<{ revision: string }>(`${path}/live`, {
          token, body: retry, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        revision = result.revision;
        retry = null;
        if (!controller.signal.aborted) setSyncing(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
          ended = true;
          if (error.code === 'DG_STALE_DRAWING' || error.status === 400) resync();
        } else {
          setSyncing(true);
          delay = RETRY_INTERVAL_MS;
        }
      } finally {
        inFlight = false;
        if (pending || retry) schedule(delay);
      }
    }

    onEdit.current = (strokes, from) => {
      latest = strokes;
      if (!pending || from.strokeIndex < pending.strokeIndex
        || (from.strokeIndex === pending.strokeIndex && from.pointIndex < pending.pointIndex)) {
        pending = from;
      }
      schedule(SEND_INTERVAL_MS);
    };
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [initial, path, token, resync]);

  return <>
    <DgSketch text={text} disabled={disabled} initialDrawing={initial} submit={submit}
      onEdit={(strokes, from) => onEdit.current(strokes, from)} />
    {syncing && <p className="guess-muted" role="status">{text.drawingSync}</p>}
  </>;
}

export function DgLivePicture({ path, text }: { path: string; text: DgText }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let frame: DgLiveDrawing = { revision: null, strokes: [] };
    let source: EventSource;
    let reconnect: number | undefined;

    function connect() {
      const stream = new EventSource(`${API_BASE}${DG_PATH}${path}/stream`);
      source = stream;
      stream.addEventListener('snapshot', (event: MessageEvent<string>) => {
        frame = JSON.parse(event.data) as DgLiveDrawing;
        paintDgDrawing(canvas.current, frame.strokes);
        setConnected(true);
      });
      stream.addEventListener('drawing', (event: MessageEvent<string>) => {
        const patch = JSON.parse(event.data) as DgDrawingPatch;
        const next = patch.baseRevision === frame.revision ? applyDgDrawingPatch(frame, patch) : null;
        if (!next) {
          stream.close();
          setConnected(false);
          reconnect = window.setTimeout(connect, 250);
          return;
        }
        const last = frame.strokes.length - 1;
        const append = patch.strokeIndex === frame.strokes.length
          || (patch.strokeIndex === last && patch.pointIndex === frame.strokes[last]?.points.length);
        paintDgDrawing(canvas.current, next.strokes, append ? patch : undefined);
        frame = next;
      });
      stream.addEventListener('closed', () => stream.close());
      stream.addEventListener('error', () => setConnected(false));
    }

    connect();
    return () => {
      source.close();
      window.clearTimeout(reconnect);
    };
  }, [path]);

  return <section className="guess-panel">
    <h2>{text.liveDrawing}</h2>
    <canvas ref={canvas} className="dg-canvas" width={DG_WIDTH} height={DG_HEIGHT} role="img" aria-label={text.liveDrawing} />
    {!connected && <p className="guess-muted" role="status">{text.drawingSync}</p>}
  </section>;
}
