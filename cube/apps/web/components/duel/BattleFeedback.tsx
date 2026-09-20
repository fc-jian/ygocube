"use client";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { DuelState, Ref } from "@ygocube/duel-protocol";
import { CardImage } from "@/components/CardImage";
import { nativeVisuals, type NativeVisual } from "./native-visuals";

type Point = { x: number; y: number };
type Visual = NativeVisual & {
  id: number;
  expires: number;
  a?: Point;
  b?: Point;
  own: boolean;
};

function point(shell: HTMLElement | null, ref: Ref): Point | undefined {
  const table = shell?.querySelector(".duel-table");
  if (!table) return;
  const location = ref.location & 127;
  const key = `${ref.player}:${location}:${ref.sequence}`;
  const element =
    location === 0
      ? table.querySelector(`[data-hand-player="${ref.player}"]`)
      : (table.querySelector(`[data-duel-ref="${key}"]`) ??
        table.querySelector(`[data-slot="${key}"]`) ??
        table.querySelector(`[data-opponent-slot="${key}"]`) ??
        table.querySelector(`[data-pile="${ref.player}:${location}"]`) ??
        (location === 2
          ? table.querySelector(`[data-hand-player="${ref.player}"]`)
          : null));
  if (!element) return;
  const rect = element.getBoundingClientRect(),
    bounds = table.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  return {
    x: ((rect.left + rect.width / 2 - bounds.left) / bounds.width) * 100,
    y: ((rect.top + rect.height / 2 - bounds.top) / bounds.height) * 100,
  };
}

// Effects run alongside authoritative state; they never delay prompts or the clock.
export function useBattleFeedback(shell: RefObject<HTMLElement>) {
  const [visuals, setVisuals] = useState<Visual[]>([]);
  const serial = useRef(0);
  const reset = () => setVisuals([]);
  const publish = (
    state: DuelState,
    frame: Uint8Array,
    previousLP: number[],
  ) => {
    if (frame[2] === 1 && [4, 5, 162].includes(frame[3])) {
      reset();
      return;
    }
    if (typeof document !== "undefined" && document.hidden) return;
    const now = performance.now();
    const additions = nativeVisuals(state, frame, previousLP).map(
      (event): Visual => ({
        ...event,
        id: ++serial.current,
        expires:
          now +
          (event.kind === "move"
            ? 500 + event.delay
            : event.kind === "banner"
              ? 950
              : 1300),
        a:
          "from" in event
            ? point(shell.current, event.from)
            : "ref" in event
              ? point(shell.current, event.ref)
              : undefined,
        b: "to" in event ? point(shell.current, event.to) : undefined,
        own:
          ("to" in event
            ? event.to.player
            : "ref" in event
              ? event.ref.player
              : event.player) === (state.seat < 2 ? state.seat : 0),
      }),
    );
    if (additions.length)
      setVisuals((previous) =>
        [
          ...previous.filter(
            (v) =>
              v.expires > now &&
              !(
                additions.some((a) => a.kind === "banner") &&
                v.kind === "banner"
              ),
          ),
          ...additions,
        ].slice(-32),
      );
  };
  useEffect(() => {
    if (!visuals.length) return;
    const timer = setTimeout(
      () => setVisuals((v) => v.filter((e) => e.expires > performance.now())),
      Math.max(
        1,
        Math.min(...visuals.map((e) => e.expires)) - performance.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [visuals]);
  useEffect(() => {
    const clear = () => {
      if (document.hidden) reset();
    };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);
  return { visuals, publish, reset };
}

export function BattleFeedback({
  visuals,
  names,
}: {
  visuals: Visual[];
  names: string[];
}) {
  return (
    <div className="duel-feedback" aria-hidden="true">
      {visuals.map((v) => {
        if (v.kind === "banner")
          return (
            <div
              key={v.id}
              className={`duel-phase-banner ${v.own ? "own" : "opponent"}`}
            >
              <small>{names[v.player]}</small>
              <strong>{v.label}</strong>
            </div>
          );
        if (v.kind === "life")
          return (
            <div
              key={v.id}
              className={`duel-life-delta ${v.own ? "own" : "opponent"} ${v.amount > 0 ? "recovery" : "damage"}`}
            >
              <small>{v.label}</small>
              <strong>
                {v.amount > 0 ? "+" : "−"}
                {Math.abs(v.amount).toLocaleString()}
              </strong>
            </div>
          );
        if (!v.a) return null;
        if (v.kind === "attack" && v.b)
          return (
            <svg
              key={v.id}
              className="duel-attack-trail"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              data-attacker={`${v.from.player}:${v.from.location}:${v.from.sequence}`}
              data-defender={
                v.to.location
                  ? `${v.to.player}:${v.to.location}:${v.to.sequence}`
                  : `player:${v.to.player}`
              }
            >
              <defs>
                <marker
                  id={`attack-tip-${v.id}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto"
                >
                  <path d="M0 0 L10 5 L0 10 L3 5 Z" />
                </marker>
              </defs>
              <path
                className="attack-glow"
                d={`M${v.a.x} ${v.a.y} L${v.b.x} ${v.b.y}`}
              />
              <path
                className="attack-line"
                markerEnd={`url(#attack-tip-${v.id})`}
                d={`M${v.a.x} ${v.a.y} L${v.b.x} ${v.b.y}`}
              />
              <circle className="attack-origin" cx={v.a.x} cy={v.a.y} r="1.2" />
            </svg>
          );
        if (v.kind === "move" && v.b)
          return (
            <div
              key={v.id}
              className="duel-travel-card"
              style={
                {
                  "--from-x": `${v.a.x}%`,
                  "--from-y": `${v.a.y}%`,
                  "--to-x": `${v.b.x}%`,
                  "--to-y": `${v.b.y}%`,
                  "--arrival-angle": `${(v.own ? 0 : 180) + (v.to.location === 4 && v.position & 12 ? 90 : 0)}deg`,
                  animationDelay: `${v.delay}ms`,
                } as CSSProperties
              }
            >
              {v.code ? (
                <CardImage
                  code={v.code}
                  name="移动卡片"
                  className="duel-travel-art"
                />
              ) : (
                <span className="duel-back" />
              )}
            </div>
          );
        if (v.kind === "target" || v.kind === "summon")
          return (
            <div
              key={v.id}
              className={`duel-field-signal signal-${v.kind}`}
              style={{ left: `${v.a.x}%`, top: `${v.a.y}%` }}
            >
              <i />
              <b>{v.label}</b>
            </div>
          );
        return null;
      })}
    </div>
  );
}

export function LifePoints({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.current = value;
      setDisplay(value);
      return;
    }
    const from = current.current,
      started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const fraction = Math.min(1, (now - started) / 400);
      current.current = Math.round(
        from + (value - from) * (1 - (1 - fraction) ** 3),
      );
      setDisplay(current.current);
      if (fraction < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <b aria-label={`${value} LP`}>{display.toLocaleString()}</b>;
}
