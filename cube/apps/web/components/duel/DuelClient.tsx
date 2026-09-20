"use client";
import { RoomDeckPicker } from "./RoomDeckPicker";
import {
  BattleFeedback,
  LifePoints,
  useBattleFeedback,
} from "./BattleFeedback";
import { DuelTimeline, framePause } from "./timeline";
import { monsterStatus } from "./native-visuals";
import { CardMeta } from "@/components/CardPreview";
import type { CardInfo } from "@/lib/types";
import { victoryReasons } from "./victory";
import {
  canCancelSelection,
  ChainPreference,
  createResponseGate,
  NativePromptDetails,
  nativePromptDetails,
  secondaryResponse,
  selectionRange,
  shouldPassChain,
  shouldSubmitSelection,
  toggleSelection,
} from "./interaction";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  applyFrame,
  initialState,
  DuelState,
  Card,
  Choice,
  Prompt,
  integer,
  encodeSelection,
  selectionValid,
  encodeDeck,
} from "@ygocube/duel-protocol";
import { CardImage } from "@/components/CardImage";
import { TokenPrompt } from "@/components/TokenPrompt";
import { API_BASE, api, Identity, resolvePlayerIdentity } from "@/lib/api";
import { duelText, DuelLanguage, races, attributes } from "./duel-text";
import { LocalPicsSetting } from "@/components/IdentityWidget";
import "./duel.css";
import "./battle-feedback.css";
import { RoomDeletedDialog } from "./RoomDeletedDialog";
import {
  cardActions,
  logCardCodes,
  sameCard,
  formatSystemText,
  effectQuestion,
  publicChoiceCode,
  chainMatches,
  duelEffect,
  DuelEffect,
} from "./presentation";
type Info = CardInfo;
type Recording = {
  frames: {
    t: number;
    frame: string;
  }[];
  snapshots: {
    index: number;
    t: number;
    state: DuelState;
  }[];
  complete: boolean;
  cards: Info[];
  descriptions: Record<number, string>;
};
const decode = (v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
const zones = [1, 2, 4, 8, 16, 32, 64];
const phaseCodes = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const label = (c: Choice, text: any) => {
  const lang = "zh";
  if (c.label?.startsWith("race"))
    return races[lang][Number(c.label.slice(4))] ?? c.label;
  if (c.label?.startsWith("attribute"))
    return attributes[lang][Number(c.label.slice(9))] ?? c.label;
  return c.label ? (text[c.label] ?? c.label) : "";
};
export function DuelClient({
  tid = "",
  pid,
  mid,
  mode = "player",
  credential,
}: {
  tid?: string;
  credential?: string;
  pid?: string;
  mid?: string;
  mode?: "player" | "watch" | "replay";
}) {
  const responseGate = useRef(createResponseGate());
  const snapshotPrompt = useRef<Prompt | null>(null);
  const promptDetails = useRef(new WeakMap<Prompt, NativePromptDetails>());
  const [responsePending, setResponsePending] = useState(false);
  const selectedRef = useRef<number[]>([]);
  const [choiceSent, setChoiceSent] = useState<number | null>(null);
  const [lang] = useState<DuelLanguage>("zh"),
    text = duelText[lang];
  const [identity, setIdentity] = useState<Identity | null>(null),
    [needToken, setNeedToken] = useState(false);
  const [state, setState] = useState<DuelState>(initialState),
    model = useRef(initialState());
  const [status, setStatus] = useState("connect"),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const socket = useRef<WebSocket | null>(null),
    promptId = useRef(0),
    [revision, setRevision] = useState(0);
  const [metadata, setMetadata] = useState<Record<number, Info>>({}),
    metadataRef = useRef(metadata),
    fetching = useRef(new Set<number>());
  const [descriptions, setDescriptions] = useState<Record<number, string>>({}),
    descriptionRequests = useRef(new Set<number>());
  const [materialRef, setMaterialRef] = useState<Choice["ref"] | null>(null);
  const [fieldPicking, setFieldPicking] = useState(false);
  const [chainAcceptedId, setChainAcceptedId] = useState<number | null>(null);
  const [chainInspectId, setChainInspectId] = useState<number | null>(null);
  useEffect(() => {
    setMaterialRef(null);
  }, [revision]);
  const [chainPassedId, setChainPassedId] = useState<number | null>(null);
  const [hoverCard, setHoverCard] = useState(0);
  const [hoverRef, setHoverRef] = useState<Choice["ref"] | null>(null);
  const [hoverPoint, setHoverPoint] = useState({ x: 0, y: 0 });
  const [operationChoices, setOperationChoices] = useState<Choice[] | null>(
    null,
  );
  const [operationRegion, setOperationRegion] = useState(false);
  const [operationAnchor, setOperationAnchor] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [pendingOperation, setPendingOperation] = useState<Choice | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const feedback = useBattleFeedback(shellRef);
  const clockAnchor = useRef(performance.now());
  const [deckSubmitting, setDeckSubmitting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRevealed, setShowRevealed] = useState(false);
  useEffect(() => {
    if (state.revealed?.length) setShowRevealed(true);
    else setShowRevealed(false);
  }, [state.revealed]);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let frame = 0,
      previous = "";
    const resize = () => {
      const viewport = window.visualViewport;
      const height = Math.max(
        240,
        (viewport?.height ?? window.innerHeight) +
          (viewport?.offsetTop ?? 0) -
          shell.getBoundingClientRect().top,
      );
      const value = `${Math.floor(height)}px`;
      if (value !== previous) {
        shell.style.setProperty("--duel-height", value);
        previous = value;
      }
      frame = requestAnimationFrame(resize);
    };
    // Position can change without a resize (fonts, room header, hydration).
    frame = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(frame);
  }, []);
  const [lobbyJoined, setLobbyJoined] = useState(false);
  const [detailRef, setDetailRef] = useState<Choice["ref"] | null>(null);
  const openDetail = (code: number, ref: Choice["ref"] = undefined) => {
    setDetailRef(ref ?? null);
    setDetail(code);
  };
  const [effects, setEffects] = useState<
    (DuelEffect & { id: number; duration: number; scale: number })[]
  >([]);
  useEffect(() => {
    const over = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      const card =
        target.closest<HTMLElement>("[data-card-code]") ??
        target.closest<HTMLElement>(".card-image");
      const image = target
        .closest("button")
        ?.querySelector<HTMLImageElement>("img");
      const code = Number(
        card?.dataset.cardCode || image?.dataset.cardCode || 0,
      );
      if (code || state.stage === "siding") setHoverCard(code);
      setHoverPoint({
        x: Math.max(8, Math.min(event.clientX + 16, window.innerWidth - 320)),
        y: Math.max(8, Math.min(event.clientY + 16, window.innerHeight - 300)),
      });
    };
    document.addEventListener("pointerover", over);
    return () => document.removeEventListener("pointerover", over);
  }, [state.stage]);
  const effectSerial = useRef(0);
  const effect = effects[0];
  const animate = (frame: Uint8Array, previousLP: number[], scale = 1) => {
    if (
      !scale ||
      document.hidden ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      (mode === "replay" && speed >= 4)
    ) {
      feedback.reset();
      setEffects([]);
      return;
    }
    feedback.publish(model.current, frame, previousLP, scale);
    if (frame[2] === 1 && [4, 5, 162].includes(frame[3])) {
      setEffects([]);
      return;
    }
    const event = duelEffect(model.current, frame);
    if (event) {
      const next = {
        ...event,
        id: ++effectSerial.current,
        duration: framePause(frame) * scale,
        scale,
      };
      setEffects([next]);
    }
  };
  useEffect(() => {
    if (!effect) return;
    const timer = setTimeout(
      () => setEffects((q) => q.filter((e) => e.id !== effect.id)),
      effect.duration,
    );
    return () => clearTimeout(timer);
  }, [effect?.id]);
  const [detail, setDetail] = useState<number | null>(null),
    [zone, setZone] = useState<{
      player: number;
      location: number;
    } | null>(null);
  const graveLocked = mode === "player" && !!state.graveLocked?.[state.seat];
  useEffect(() => {
    if (!graveLocked) return;
    setZone((current) => (current?.location === 16 ? null : current));
    setOperationChoices((current) =>
      current?.some((c) => c.ref?.location === 16) ? null : current,
    );
    if (detailRef?.location === 16) setDetail(null);
  }, [graveLocked]);
  const [selected, setSelected] = useState<number[]>([]),
    [amounts, setAmounts] = useState<number[]>([]),
    [preference, setPreference] = useState<ChainPreference>("available");
  const [search, setSearch] = useState(""),
    [results, setResults] = useState<Info[]>([]),
    [confirmQuit, setConfirmQuit] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [elapsed, setElapsed] = useState(0);
  const [side, setSide] = useState<{
      main: number[];
      side: number[];
    } | null>(null),
    [recording, setRecording] = useState<Recording | null>(null),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0),
    timeRef = useRef(0);
  const repaint = useCallback(
    () =>
      setState({
        ...model.current,
        cards: [...model.current.cards],
        logs: [...model.current.logs],
      }),
    [],
  );
  const action = useCallback(
    (opcode: number, data: Uint8Array = new Uint8Array()) => {
      if (socket.current?.readyState !== WebSocket.OPEN) return;
      socket.current.send(
        JSON.stringify({
          type: "action",
          id: promptId.current,
          opcode,
          data: Array.from(data),
        }),
      );
    },
    [],
  );
  const respond = useCallback(
    (data: Uint8Array) => {
      if (
        mode !== "player" ||
        socket.current?.readyState !== WebSocket.OPEN ||
        !responseGate.current.claim(revision, state.prompt)
      )
        return false;
      snapshotPrompt.current = null;
      action(1, data);
      setResponsePending(true);
      setOperationChoices(null);
      setPendingOperation(null);
      return true;
    },
    [action, mode, revision, state.prompt],
  );
  useEffect(() => {
    if (mode !== "player" || credential) return;
    let cancelled = false;
    api<{
      authRequired: boolean;
    }>(`/t/${encodeURIComponent(tid)}`, { identity: null })
      .then((info) => {
        if (cancelled) return;
        if (!info.authRequired) setIdentity({ tid, pid: pid!, token: "" });
        else {
          const i = resolvePlayerIdentity(tid, pid!);
          if ("needToken" in i) setNeedToken(true);
          else setIdentity(i.identity);
        }
      })
      .catch((e) => setError(String(e.message)));
    return () => {
      cancelled = true;
    };
  }, [tid, pid, mode, credential]);
  useEffect(() => {
    if (mode === "replay") {
      let cancelled = false;
      api<Recording>(`/public/t/${tid}/matches/${mid}/replay`, {
        identity: null,
      })
        .then((r) => {
          if (cancelled) return;
          setRecording(r);
          setDescriptions(r.descriptions ?? {});
          const cards = Object.fromEntries(r.cards.map((c) => [c.code, c]));
          setMetadata(cards);
          metadataRef.current = cards;
          setStatus("replay");
        })
        .catch(() => setError(text.replayLocked));
      return () => {
        cancelled = true;
      };
    }
    if (mode === "player" && !identity && !credential) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      retries = 0,
      ws: WebSocket | undefined;
    let latestPromptRevision = -1;
    const timeline = new DuelTimeline();
    const visibility = () => {
      if (document.hidden) timeline.flush();
    };
    document.addEventListener("visibilitychange", visibility);
    const connect = async () => {
      try {
        setStatus("connect");
        setLobbyJoined(false);
        let matchId = mid;
        if (mode === "player" && !credential) {
          const matches = await api<
            {
              id: number;
              resultA: number | null;
              resultB: number | null;
            }[]
          >(`/t/${tid}/matches`, { identity });
          matchId = String(
            matches.find((m) => m.resultA === null && m.resultB === null)?.id ??
              "",
          );
          if (!matchId) throw new Error("MATCH_NOT_FOUND");
        }
        const session = await api<{
          ticket: string;
          wsPath: string;
        }>(
          credential
            ? "/public/duel/session"
            : mode === "player"
              ? `/t/${tid}/matches/${matchId}/duel-session`
              : `/public/t/${tid}/matches/${matchId}/watch-session`,
          {
            method: "POST",
            identity: mode === "player" ? identity : null,
            ...(credential ? { body: { credential } } : {}),
          },
        );
        if (disposed) return;
        const url = new URL(
          session.wsPath.replace(/^\/api(?=\/)/, API_BASE),
          location.href,
        );
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        socket.current = ws;
        timeline.clear();
        model.current = initialState();
        snapshotPrompt.current = null;
        responseGate.current.begin(-1);
        setResponsePending(false);
        repaint();
        setError("");
        ws.onopen = () =>
          ws!.send(
            JSON.stringify({
              type: "auth",
              version: 1,
              ticket: session.ticket,
            }),
          );
        const receive = (e: MessageEvent, scale = 1) => {
          if (disposed) return;
          try {
            if (typeof e.data === "string") {
              const v = JSON.parse(e.data);
              if (v.type === "snapshot") {
                model.current = v.state;
                feedback.reset();
                snapshotPrompt.current = model.current.prompt;
                responseGate.current.bind(model.current.prompt);
                clockAnchor.current = performance.now();
                setElapsed(0);
                setEffects([]);
                repaint();
              }
              if (v.type === "session") {
                setStatus("connected");
                retries = 0;
              }
              if (v.type === "prompt") {
                responseGate.current.begin(v.id);
                if (snapshotPrompt.current === model.current.prompt) {
                  responseGate.current.bind(snapshotPrompt.current);
                  snapshotPrompt.current = null;
                }
                setResponsePending(v.id !== latestPromptRevision);
                selectedRef.current = [];
                setSelected([]);
                setOperationChoices(null);
                setPendingOperation(null);
                setFieldPicking(false);
                setMaterialRef(null);
                setChainAcceptedId(null);
                setChainInspectId(null);
                setChainPassedId(null);
                promptId.current = v.id;
                setRevision(v.id);
              }
              if (v.type === "accepted") {
                setError("");
                model.current.prompt = null;
                responseGate.current.bind(null);
                if (model.current.timePlayer < 2) {
                  const player = model.current.timePlayer;
                  model.current.time[player] = Math.max(
                    0,
                    model.current.time[player] -
                      (performance.now() - clockAnchor.current) / 1000,
                  );
                }
                model.current.timePlayer = 2;
                if (v.opcode === 2) {
                  setDeckSubmitting(false);
                  model.current.stage =
                    v.stage === "lobby" ? "lobby" : "waitingSide";
                }
                repaint();
              }
              if (v.type === "error") {
                setDeckSubmitting(false);
                // A stale-action error must not re-arm an already sent response.
                if (v.code === "INVALID_ACTION") {
                  responseGate.current.reject(
                    promptId.current,
                    model.current.prompt,
                  );
                  setResponsePending(false);
                  setChainPassedId(null);
                }
                zoneSubmitted.current = false;
                zoneSelected.current = [];
                selectedRef.current = [];
                setSelected([]);
                setChoiceSent(null);
                setError(v.message ?? v.code);
              }
              if (v.type === "ended") setStatus("ended");
              return;
            }
            const frame = new Uint8Array(e.data);
            if (frame[2] === 3 || frame[2] === 4) setChoiceSent(null);
            const previousPrompt = model.current.prompt;
            const previousLP = [...model.current.lp];
            applyFrame(model.current, frame);
            snapshotPrompt.current = null;
            const nextPrompt = model.current.prompt;
            if (nextPrompt && nextPrompt !== previousPrompt && frame[3] !== 1)
              promptDetails.current.set(nextPrompt, nativePromptDetails(frame));
            responseGate.current.bind(nextPrompt);
            if (frame[2] === 0x18) {
              clockAnchor.current = performance.now();
              setElapsed(0);
            }
            if (frame[2] === 0x13) setLobbyJoined(true);
            animate(frame, previousLP, scale);
            if (model.current.error === "RETRY") {
              zoneSubmitted.current = false;
              zoneSelected.current = [];
              selectedRef.current = [];
              setSelected([]);
              setError(duelText[lang].retry);
            } else if (model.current.error) {
              const code = Number(
                model.current.error.replace("HOST_ERROR_", ""),
              );
              const kind = code >>> 28,
                value = code & 0xfffffff;
              const name = metadataRef.current[value]?.name ?? `卡片 ${value}`;
              const reasons: Record<number, string> = {
                1: `「${name}」违反房间禁限卡表`,
                2: `「${name}」为 OCG 专用卡，房间规则不允许`,
                3: `「${name}」为 TCG 专用卡，房间规则不允许`,
                4: `服务器无法识别卡片 ${value}`,
                5: `「${name}」的同名卡数量超过限制`,
                6: `主卡组 ${value} 张，不符合房间数量规则`,
                7: `额外卡组 ${value} 张，不符合房间数量规则`,
                8: `副卡组 ${value} 张，不符合房间数量规则`,
                9: `「${name}」不在房间允许的卡片范围内`,
              };
              setError(
                reasons[kind] ?? "服务器未接受操作，请核对房间和卡组规则",
              );
              model.current.error = undefined;
            }
            repaint();
          } catch (e) {
            setError(String((e as Error).message));
            ws!.close(4010, "PROTOCOL_ERROR");
          }
        };
        ws.onmessage = (e) => {
          if (disposed) return;
          if (typeof e.data === "string") {
            let type: string;
            try {
              const message = JSON.parse(e.data);
              type = message.type;
              if (type === "prompt") {
                latestPromptRevision = message.id;
                setResponsePending(true);
              }
            } catch {
              receive(e);
              return;
            }
            if (type === "snapshot" || type === "session") {
              timeline.clear();
              receive(e);
              return;
            }
            if (document.hidden) receive(e, 0);
            else timeline.push((scale) => receive(e, scale));
            return;
          }
          const frame = new Uint8Array(e.data);
          // Clock packets are authoritative immediately, even while scenery is playing.
          if (frame[2] === 0x18) {
            receive(e);
            return;
          }
          if (
            document.hidden ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ) {
            timeline.flush();
            receive(e, 0);
          } else timeline.push((scale) => receive(e, scale), framePause(frame));
        };
        ws.onclose = (e) => {
          timeline.flush();
          if (disposed) return;
          if (model.current.stage === "ended") {
            setStatus("ended");
            return;
          }
          setStatus(e.code === 4009 ? "takeover" : "connect");
          if ([4009, 4010, 4003].includes(e.code)) {
            setError(e.reason);
            return;
          }
          timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retries++));
        };
        ws.onerror = () => setError(duelText[lang].error);
      } catch (e: any) {
        if (!disposed) {
          setError(e.code ?? e.message);
          setStatus("error");
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      timeline.clear();
      document.removeEventListener("visibilitychange", visibility);
      if (timer) clearTimeout(timer);
      ws?.close();
      socket.current = null;
    };
  }, [mode, tid, pid, mid, identity, attempt, repaint, credential]);
  useEffect(() => {
    setFieldPicking(false);
    setCollapsed(false);
    setOperationChoices(null);
    setPendingOperation(null);
    selectedRef.current = [];
    setSelected([]);
    setAmounts(Array(state.prompt?.choices.length ?? 0).fill(0));
    setSearch("");
    setResults([]);
  }, [state.prompt, revision]);
  useEffect(() => {
    if (state.stage === "siding")
      setSide({ main: [...state.deck.main], side: [...state.deck.side] });
  }, [state.stage]);
  useEffect(() => {
    const codes = new Set<number>();
    for (const line of state.logs)
      for (const code of logCardCodes(line)) codes.add(code);
    for (const c of state.cards) {
      if (c.code) codes.add(c.code);
      for (const v of c.materials) if (v) codes.add(v);
    }
    for (const c of [
      ...(state.prompt?.choices ?? []),
      ...(state.prompt?.mandatory ?? []),
      ...state.chain,
    ])
      if (c.code) codes.add(c.code);
    for (const c of [
      ...state.deck.main,
      ...state.deck.side,
      ...(state.revealed ?? []),
    ])
      codes.add(c);
    const missing = [...codes]
      .filter((c) => !metadataRef.current[c] && !fetching.current.has(c))
      .slice(0, 256);
    if (!missing.length) return;
    missing.forEach((c) => fetching.current.add(c));
    let done = false;
    api<Info[]>("/public/duel/cards", {
      method: "POST",
      identity: null,
      body: { codes: missing },
    })
      .then((cs) => {
        const next = {
          ...metadataRef.current,
          ...Object.fromEntries(cs.map((c) => [c.code, c])),
        };
        metadataRef.current = next;
        setMetadata(next);
      })
      .catch(() => {
        missing.forEach((c) => fetching.current.delete(c));
      });
  }, [state]);
  useEffect(() => {
    if (mode === "replay") return;
    const ids = [
      state.prompt?.message === 12
        ? state.prompt.hint || 200
        : state.prompt?.hint,
      ...(state.prompt?.choices ?? []).map((c) => c.description),
    ].filter(
      (id): id is number => !!id && !descriptionRequests.current.has(id),
    );
    if (!ids.length) return;
    ids.forEach((id) => descriptionRequests.current.add(id));
    api<Record<number, string>>("/public/duel/descriptions", {
      method: "POST",
      identity: null,
      body: { ids },
    })
      .then((v) => setDescriptions((d) => ({ ...d, ...v })))
      .catch(() => {});
  }, [state.prompt]);
  useEffect(() => {
    const p = state.prompt;
    if (
      shouldPassChain(
        p,
        preference,
        p ? promptDetails.current.get(p) : undefined,
      )
    )
      respond(integer(-1));
  }, [state.prompt, preference, respond]);
  useEffect(() => {
    if (state.prompt?.kind !== "declare" || !search.trim()) return;
    let cancelled = false;
    const timer = setTimeout(
      () =>
        api<Info[]>("/public/duel/declare", {
          method: "POST",
          identity: null,
          body: { q: search, opcodes: state.prompt?.opcodes },
        })
          .then((cs) => {
            if (!cancelled) setResults(cs);
          })
          .catch(() => {}),
      250,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, state.prompt]);
  const seek = useCallback(
    (index: number) => {
      if (!recording) return;
      feedback.reset();
      setEffects([]);
      setHoverRef(null);
      const snap = [...recording.snapshots]
        .reverse()
        .find((s) => s.index <= index);
      model.current = snap
        ? JSON.parse(JSON.stringify(snap.state))
        : initialState();
      try {
        for (let i = snap?.index ?? 0; i < index; i++)
          applyFrame(model.current, decode(recording.frames[i].frame));
      } catch (e) {
        setError(String(e));
      }
      cursorRef.current = index;
      timeRef.current = recording.frames[Math.max(0, index - 1)]?.t ?? 0;
      setCursor(index);
      repaint();
    },
    [recording, repaint],
  );
  useEffect(() => {
    if (!playing || !recording) return;
    let last = performance.now(),
      holdUntil = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      if (now < holdUntil) {
        last = now;
        return;
      }
      timeRef.current += (now - last) * speed;
      last = now;
      let i = cursorRef.current;
      try {
        while (
          i < recording.frames.length &&
          recording.frames[i].t <= timeRef.current
        ) {
          const frame = decode(recording.frames[i++].frame);
          const previousLP = [...model.current.lp];
          applyFrame(model.current, frame);
          animate(frame, previousLP, 1 / speed);
          const pause =
            speed < 4 &&
            !document.hidden &&
            !window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? framePause(frame) / speed
              : 0;
          if (pause) {
            holdUntil = now + pause;
            timeRef.current = recording.frames[i - 1].t;
            break;
          }
        }
        cursorRef.current = i;
        setCursor(i);
        repaint();
        if (i === recording.frames.length) setPlaying(false);
      } catch (e) {
        setPlaying(false);
        setError(String(e));
      }
    }, 50);
    return () => clearInterval(timer);
  }, [playing, recording, speed, repaint]);
  useEffect(() => {
    if (mode === "replay") return;
    const tick = () =>
      setElapsed(Math.max(0, (performance.now() - clockAnchor.current) / 1000));
    const interval = setInterval(tick, 100);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [mode]);
  const zoneSubmitted = useRef(false);
  const zoneSelected = useRef<number[]>([]);
  useEffect(() => {
    zoneSubmitted.current = false;
    zoneSelected.current = [];
  }, [state.prompt, revision]);
  const placePrompt =
    mode === "player" && state.prompt?.kind === "place"
      ? state.prompt
      : undefined;
  const decisionDisabled =
    responsePending || !responseGate.current.canSend(revision, state.prompt);
  const selectZone = (choice: Choice) => {
    if (
      !placePrompt ||
      zoneSubmitted.current ||
      !responseGate.current.canSend(revision, placePrompt)
    )
      return;
    const previous = zoneSelected.current;
    const next = previous.includes(choice.index)
      ? previous.filter((i) => i !== choice.index)
      : [...previous, choice.index];
    zoneSelected.current = next;
    selectedRef.current = next;
    setSelected(next);
    if (next.length === Math.max(1, placePrompt.min)) {
      zoneSubmitted.current = respond(encodeSelection(placePrompt, next));
    }
  };
  const zoneTarget = (
    refs: {
      player: number;
      location: number;
      sequence: number;
    }[],
  ) => {
    const choice = refs.flatMap(
      (ref) =>
        placePrompt?.choices.filter(
          (c) =>
            c.ref?.player === ref.player &&
            c.ref.location === ref.location &&
            c.ref.sequence === ref.sequence,
        ) ?? [],
    )[0];
    if (!choice) return null;
    const chosen = selected.includes(choice.index);
    const ref = choice.ref!;
    return (
      <button
        type="button"
        className={`duel-zone-target ${chosen ? "chosen" : ""}`}
        data-zone={`${ref.player}:${ref.location}:${ref.sequence}`}
        aria-label={`${state.names[ref.player]} · ${ref.location === 4 ? "怪" : "魔"}${ref.sequence + 1}`}
        aria-pressed={chosen}
        disabled={zoneSubmitted.current || decisionDisabled}
        onClick={() => selectZone(choice)}
      >
        <span>{chosen ? "✓" : "＋"}</span>
      </button>
    );
  };
  const toggle = (p: Prompt, i: number) => {
    if (!responseGate.current.canSend(revision, p)) return;
    const previous = selectedRef.current;
    const next = toggleSelection(p, previous, i);
    if (next === previous) return;
    selectedRef.current = next;
    setSelected(next);
    if (
      next.length > previous.length &&
      shouldSubmitSelection(p, next, selectionValid(p, next, amounts))
    )
      respond(encodeSelection(p, next, amounts));
  };
  const choose = (p: Prompt, c: Choice) => {
    if (chainConfirmation || !responseGate.current.canSend(revision, p)) return;
    if (p.kind === "unselect") respond(new Uint8Array([1, c.index]));
    else if (["command", "yesno", "chain", "position"].includes(p.kind))
      respond(integer(c.value ?? c.index));
    else toggle(p, c.index);
  };
  const finishSelection = () => {
    const p = state.prompt,
      indices = selectedRef.current;
    if (p && selectionValid(p, indices, amounts))
      respond(encodeSelection(p, indices, amounts));
  };
  const cancelSelection = () => {
    const p = state.prompt;
    if (!p || !canCancelSelection(p, selectedRef.current.length)) return;
    if (
      respond(
        p.kind === "place" ? new Uint8Array([p.player, 0, 0]) : integer(-1),
      ) &&
      p.kind === "place"
    )
      zoneSubmitted.current = true;
  };
  const own = mode === "player" && state.seat < 2 ? state.seat : 0,
    opponent = 1 - own;
  const zoneName = (loc: number) =>
    text.zones[zones.indexOf(loc)] ?? String(loc);
  const cardName = (code: number) => metadata[code]?.name ?? text.unknown;
  const formatLog = (line: string) => {
    const parts = line.split(":");
    const n = Number(parts[1]),
      v = Number(parts[2]);
    switch (parts[0]) {
      case "turn":
        return `回合 ${n} · ${state.names[v]}`;
      case "phase":
        return text.phases[phaseCodes.indexOf(n)] ?? line;
      case "draw":
        return `${state.names[n]} · ${"抽卡"} × ${v}`;
      case "attack":
        return `${cardName(n)} ${parts[3] === "1" ? "直接攻击" : `攻击 ${v ? cardName(v) : parts[3] === "0" ? "里侧怪兽" : "目标 / 直接攻击"}`}`;
      case "activate":
        return `${state.names[v]} · ${zoneName(Number(parts[4]))}发动 · 连锁 ${parts[3]} · ${cardName(n)}`;
      case "reveal":
        return `${state.names[v]} 展示 · ${cardName(n)}`;
      case "summon":
        return `${text.summon} · ${cardName(n)}`;
      case "move":
        return `${cardName(n)} → ${zoneName(Number(parts[3]))}`;
      case "win":
        return `${state.names[n] ?? "平局"} ✓`;
      case "chain":
        return `${text.chain} ${v} · ${{ 71: "形成", 72: "处理中", 73: "处理完成", 75: "发动无效", 76: "效果无效" }[n] ?? ""}`;
      case "hint":
        return formatSystemText(descriptions[v], [], metadata[v]?.name ?? "");
      case "event":
        return (
          (
            {
              110: text.attack,
              111: text.battle,
              130: "投硬币",
              131: "掷骰子",
              61: text.summon,
              63: text.special,
            } as Record<number, string>
          )[n] ?? ""
        );
      default:
        return line;
    }
  };
  const operationLabel = (c: Choice) =>
    label(c, text) || (state.prompt?.kind === "chain" ? "发动效果" : "选择");
  const choiceCode = (c: Choice) => publicChoiceCode(c, state, own);
  const centralPrompt =
    mode === "player" &&
    !!state.prompt &&
    ![10, 11, 18, 24].includes(state.prompt.message) &&
    (state.prompt.kind !== "chain" || !state.prompt.cancel);
  const canPickField =
    centralPrompt &&
    !!state.prompt?.choices.some((c) => c.ref) &&
    ["cards", "tribute", "sum", "unselect", "sort"].includes(
      state.prompt!.kind,
    );
  const chainConfirmation =
    mode === "player" &&
    state.prompt?.kind === "chain" &&
    state.prompt.cancel &&
    !shouldPassChain(
      state.prompt,
      preference,
      promptDetails.current.get(state.prompt),
    ) &&
    chainAcceptedId !== revision;
  const passChain = () => {
    if (state.prompt?.kind !== "chain" || !state.prompt.cancel) return;
    if (respond(integer(-1))) setChainPassedId(revision);
  };
  const secondaryAction = (e: React.MouseEvent) => {
    if (
      (e.target as HTMLElement).closest(
        "input, textarea, select, a, [contenteditable=true]",
      )
    )
      return;
    if (confirmQuit) {
      e.preventDefault();
      setConfirmQuit(false);
      return;
    }
    if (showHistory || showRevealed) {
      e.preventDefault();
      setShowHistory(false);
      setShowRevealed(false);
      return;
    }
    if (materialRef) {
      e.preventDefault();
      setMaterialRef(null);
      return;
    }
    if (detail !== null || zone !== null) {
      e.preventDefault();
      setDetail(null);
      setZone(null);
      return;
    }
    if (operationChoices) {
      e.preventDefault();
      setOperationChoices(null);
      setPendingOperation(null);
      return;
    }
    if (mode !== "player" || !state.prompt || status !== "connected") return;
    const p = state.prompt;
    if (p.kind === "chain" && p.cancel) {
      e.preventDefault();
      if (chainConfirmation && chainInspectId === revision)
        setChainInspectId(null);
      else if (chainConfirmation) passChain();
      else if (chainPassedId !== revision) setChainAcceptedId(null);
      return;
    }
    const response = secondaryResponse(
      p,
      selectedRef.current.length,
      selectionValid(p, selectedRef.current, amounts),
    );
    if (response === "none") return;
    e.preventDefault();
    if (response === "finish") finishSelection();
    else if (response === "cancel") cancelSelection();
    else respond(integer(0));
  };
  const playable =
    mode === "player" &&
    !!state.prompt &&
    !chainConfirmation &&
    chainPassedId !== revision &&
    ["command", "chain"].includes(state.prompt.kind);
  const links = state.chain;
  const hoveredEntity = state.cards.find(
    (c) => sameCard(hoverRef ?? undefined, c) && c.code === hoverCard,
  );
  const relationTo = (c: Card) => {
    if (!hoveredEntity || sameCard(hoveredEntity, c)) return "";
    if (sameCard(hoveredEntity.equip, c) || sameCard(c.equip, hoveredEntity))
      return "装备";
    if (
      hoveredEntity.targets?.some((ref) => sameCard(ref, c)) ||
      c.targets?.some((ref) => sameCard(ref, hoveredEntity))
    )
      return "对象";
    return "";
  };
  const cardButton = (c: Card, small = false, inspectOnly = false) => {
    const choices =
      mode === "player"
        ? (state.prompt?.choices ?? []).filter(
            (choice) =>
              sameCard(choice.ref, c) ||
              (!!(choice.ref?.location && choice.ref.location & 128) &&
                choice.ref!.player === c.player &&
                (choice.ref!.location & 127) === c.location &&
                choice.ref!.sequence === c.sequence),
          )
        : [];
    const canSelect =
      choices.length > 0 &&
      !!state.prompt &&
      !["place", "yesno", "position", "counter"].includes(state.prompt.kind);
    const chosen = choices.some(
      (choice) => selected.includes(choice.index) || choice.selected,
    );
    const facedown = !!(c.location & (4 | 8 | 32 | 64)) && !!(c.position & 10);
    const knownSet =
      facedown &&
      !!c.code &&
      ((mode === "player" && c.player === own) || mode === "replay");
    const visible = !!c.code && (!facedown || knownSet);
    const stats = monsterStatus(c, metadata[c.code]);
    const relation = relationTo(c);
    const attackReady =
      playable && choices.some((choice) => choice.label === "attack");
    return (
      <Fragment key={`${c.player}:${c.location}:${c.sequence}`}>
        <button
          style={feedback.moving(c) ? { visibility: "hidden" } : undefined}
          className={`duel-card ${relation ? "duel-related" : ""} ${canSelect ? "card-selectable" : ""} ${chosen ? "card-chosen" : ""} ${knownSet ? "known-set" : ""} ${effect?.ref && sameCard(effect.ref, c) && effect.code === c.code ? "duel-effect-source" : ""} ${c.player === opponent && c.location === 4 && c.sequence >= 5 ? "opponent-extra" : ""} ${small ? "duel-small" : ""} ${c.location === 4 && c.position & 12 ? "defense" : ""}`}
          data-duel-ref={`${c.player}:${c.location}:${c.sequence}`}
          onPointerEnter={() => {
            setHoverRef(c);
            if (visible) setHoverCard(c.code);
          }}
          onPointerLeave={() => setHoverRef(null)}
          onFocus={() => {
            setHoverRef(c);
            if (visible) setHoverCard(c.code);
          }}
          onBlur={() => setHoverRef(null)}
          onClick={(event) => {
            if (state.prompt && decisionDisabled) return;
            if (chainConfirmation || inspectOnly) {
              if (visible) {
                if (inspectOnly) setZone(null);
                openDetail(c.code, c);
              }
              return;
            }
            if (
              canSelect &&
              choices.some(
                (choice) =>
                  !!(choice.ref?.location && choice.ref.location & 128),
              )
            ) {
              setMaterialRef(c);
              return;
            }
            if (canSelect && state.prompt) {
              if (playable) {
                setZone(null);
                setDetail(null);
                setOperationRegion(false);
                const bounds = event.currentTarget.getBoundingClientRect();
                setOperationAnchor({
                  left: Math.max(
                    8,
                    Math.min(bounds.right + 8, window.innerWidth - 284),
                  ),
                  top: Math.max(
                    8,
                    Math.min(
                      bounds.top,
                      window.innerHeight -
                        Math.min(440, 88 + choices.length * 56),
                    ),
                  ),
                });
                setPendingOperation(null);
                setOperationChoices(choices);
              } else choose(state.prompt, choices[0]);
            } else if (visible) openDetail(c.code, c);
            else setZone({ player: c.player, location: c.location });
          }}
          aria-pressed={canSelect ? chosen : undefined}
          data-card-code={visible ? c.code : undefined}
          aria-label={visible ? cardName(c.code) : text.unknown}
        >
          {!!c.materials.length && (
            <span
              className={`duel-material-stack ${c.position & 12 ? "turned" : ""}`}
              aria-hidden="true"
            >
              {c.materials.slice(0, 4).map((code, index) => (
                <span
                  className="duel-material-layer"
                  key={`${index}:${code}`}
                  style={
                    {
                      "--material-offset": `${(index + 1) * 4}px`,
                      "--material-delay": `${index * 65}ms`,
                      zIndex: -index,
                    } as React.CSSProperties
                  }
                >
                  {code ? (
                    <CardImage
                      code={code}
                      name={cardName(code)}
                      className="duel-material-art"
                    />
                  ) : (
                    <span className="duel-back" />
                  )}
                </span>
              ))}
            </span>
          )}
          {[32, 64].includes(c.location) && (
            <span className="duel-position-label">
              {c.position & 5 ? "表侧" : "里侧"}
            </span>
          )}
          {knownSet && <span className="duel-back set-back" />}
          {visible ? (
            <CardImage
              code={c.code}
              name={cardName(c.code)}
              className="duel-image"
            />
          ) : (
            <span className="duel-back" />
          )}
          {c.location === 4 && visible && (
            <>
              <span className="duel-stat">
                <b className={stats.atkTone}>{stats.atk}</b>
                <span>/</span>
                <b className={stats.defTone}>{stats.def}</b>
              </span>
              {stats.badge && (
                <span className="duel-monster-rank">{stats.badge}</span>
              )}
            </>
          )}
          {visible &&
            !!(c.position & 5) &&
            !!(c.status && c.status & 0x4000001) && (
              <span className="duel-negated-mark" aria-label="效果无效或禁止">
                ⊘
              </span>
            )}
          {visible &&
            c.location === 8 &&
            !!((c.type ?? metadata[c.code]?.type ?? 0) & 0x1000000) && (
              <span className="duel-pendulum-scale">
                {c.lscale ?? metadata[c.code]?.lscale} ◇{" "}
                {c.rscale ?? metadata[c.code]?.rscale}
              </span>
            )}
          {relation && <span className="duel-relation-mark">{relation}</span>}
          {links
            .filter((link) => chainMatches(link, c, state))
            .map((link, index) => (
              <span
                className={`duel-chain-marker ${effect?.index === link.index ? "resolving" : ""}`}
                key={link.index}
                style={{ "--chain-offset": index } as React.CSSProperties}
                aria-label={`连锁 ${link.index}`}
              >
                <small>连锁</small>
                <b>{link.index}</b>
              </span>
            ))}
          {attackReady && (
            <span className="duel-attack-ready" aria-label="可以攻击">
              ↑
            </span>
          )}
          {canSelect && playable && !attackReady && (
            <span className="duel-action-vortex" aria-hidden="true" />
          )}

          {Object.keys(c.counters).length > 0 && (
            <span className="duel-counters">
              {Object.entries(c.counters)
                .map(([k, v]) => `${k}:${v}`)
                .join(" ")}
            </span>
          )}
        </button>
        {!!c.materials.length && (
          <button
            type="button"
            className="duel-material-count"
            aria-label={`查看超量素材（${c.materials.length}）`}
            onClick={() => setMaterialRef(c)}
          >
            素材 {c.materials.length}
          </button>
        )}
      </Fragment>
    );
  };
  const slots = (p: number, l: number, n: number, start = 0) =>
    Array.from({ length: n }, (_, offset) => {
      const i = offset + start;
      const c = state.cards.find(
        (c) => c.player === p && c.location === l && c.sequence === i,
      );
      return (
        <div
          key={i}
          data-slot={`${p}:${l}:${i}`}
          className={`duel-slot ${state.disabled & (1 << (p * 16 + (l === 8 ? 8 : 0) + i)) ? "disabled" : ""}`}
        >
          {c ? (
            cardButton(c)
          ) : (
            <span>
              {l === 8 && i >= 5
                ? ["场地", "灵摆◀", "灵摆▶"][i - 5]
                : `${l === 4 ? "怪" : "魔"}${i + 1}`}
            </span>
          )}
          {zoneTarget([{ player: p, location: l, sequence: i }])}
        </div>
      );
    });
  const pile = (p: number, l: number) => {
    const cards = state.cards
      .filter((c) => c.player === p && c.location === l)
      .sort((a, b) => a.sequence - b.sequence);
    const arrived = cards.filter((c) => !feedback.moving(c));
    const top = arrived[arrived.length - 1];
    const operations = playable
      ? state.prompt!.choices.filter(
          (c) => c.ref?.player === p && c.ref.location === l,
        )
      : [];
    const pileLinks = links.filter(
      (c) => c.ref?.player === p && c.ref.location === l,
    );
    const visible =
      top && l !== 1 && (![32, 64].includes(l) || !!(top.position & 5));
    return (
      <button
        key={l}
        data-pile={`${p}:${l}`}
        disabled={l === 16 && graveLocked}
        title={l === 16 && graveLocked ? "当前效果不允许查看墓地" : undefined}
        className={`duel-pile ${operations.length ? "actionable-pile" : ""} ${cards.length ? "populated" : ""}`}
        onClick={() =>
          operations.length
            ? (setOperationRegion(true),
              setPendingOperation(null),
              setOperationChoices(operations))
            : setZone({ player: p, location: l })
        }
        aria-label={`${zoneName(l)} ${cards.length}`}
      >
        <span
          className="duel-pile-art"
          key={`${cards.length}:${top?.code ?? 0}`}
        >
          {visible && top.code ? (
            <CardImage
              code={top.code}
              name={cardName(top.code)}
              className="duel-image"
            />
          ) : arrived.length ? (
            <span className="duel-back" />
          ) : (
            <span className="duel-empty-pile">
              {l === 16 ? "♧" : l === 32 ? "◇" : "▱"}
            </span>
          )}
        </span>
        {!!operations.length && (
          <span className="duel-action-vortex" aria-label="可发动或召唤" />
        )}
        {pileLinks.map((link, index) => (
          <span
            className="duel-chain-marker"
            key={link.index}
            style={{ "--chain-offset": index } as React.CSSProperties}
          >
            <small>连锁</small>
            <b>{link.index}</b>
          </span>
        ))}
        <span className="duel-pile-label">
          {zoneName(l)}{" "}
          <strong>
            {cards.length}
            {[32, 64].includes(l)
              ? `(${cards.filter((c) => !!(c.position & 5)).length})`
              : ""}
          </strong>
        </span>
      </button>
    );
  };
  const row = (p: number) => (
    <section className={`duel-half ${p === opponent ? "opponent" : ""}`}>
      <div className="duel-field-half">
        <div className="duel-field-left">
          <div className="duel-field-zone">{slots(p, 8, 1, 5)}</div>
          {pile(p, 64)}
        </div>
        <div className="duel-field-center">
          <div className="duel-zone-row">{slots(p, 4, 5)}</div>
          <div className="duel-zone-row">{slots(p, 8, 5)}</div>
          {(state.rule <= 3 ||
            state.cards.some(
              (c) => c.player === p && c.location === 8 && c.sequence >= 6,
            ) ||
            placePrompt?.choices.some(
              (c) =>
                c.ref?.player === p &&
                c.ref.location === 8 &&
                c.ref.sequence >= 6,
            )) && <div className="duel-pendulum-row">{slots(p, 8, 2, 6)}</div>}
        </div>
        <div className="duel-field-right">{[16, 1].map((l) => pile(p, l))}</div>
      </div>
      <div className="duel-player">
        <span>
          {state.names[p]} {state.turnPlayer === p ? "◈" : ""}
        </span>
        <strong>
          {state.lp[p].toLocaleString()} <small>LP</small>
        </strong>
        <span className="duel-clock">
          {state.timePlayer === p ? "◷ " : ""}
          {state.time[p]
            ? `${Math.max(0, Math.floor(state.time[p] - (state.timePlayer === p ? elapsed : 0)))}s`
            : ""}
        </span>
      </div>
    </section>
  );
  const sharedExtras = (
    <div className="duel-shared-extras">
      <div className="duel-banished opponent-pile">{pile(opponent, 32)}</div>
      {(state.rule >= 4 ? [0, 1] : []).map((i) => (
        <div
          key={i}
          className={`duel-slot ${state.disabled & ((1 << (own * 16 + i + 5)) | (1 << (opponent * 16 + 6 - i))) ? "disabled" : ""}`}
          data-extra-slot={i}
          data-slot={`${own}:4:${i + 5}`}
          data-opponent-slot={`${opponent}:4:${6 - i}`}
          style={{ gridColumn: i === 0 ? 3 : 5 }}
        >
          {state.cards
            .filter(
              (c) =>
                c.location === 4 &&
                ((c.player === own && c.sequence === i + 5) ||
                  (c.player === opponent && c.sequence === 6 - i)),
            )
            .map((c) => cardButton(c))}
          <span>额外 {i + 1}</span>
          {zoneTarget([
            { player: own, location: 4, sequence: i + 5 },
            { player: opponent, location: 4, sequence: 6 - i },
          ])}
        </div>
      ))}
      <div className="duel-banished own-pile">{pile(own, 32)}</div>
    </div>
  );
  if (needToken && pid)
    return (
      <TokenPrompt
        tid={tid}
        pid={pid}
        onToken={(token) => {
          setNeedToken(false);
          setIdentity({ tid, pid, token });
        }}
      />
    );
  return (
    <main
      ref={shellRef}
      className="duel-shell duel-playing"
      onContextMenu={secondaryAction}
    >
      <header className="duel-header">
        <a
          href={
            credential
              ? "/duel"
              : pid
                ? `/t/${tid}/matches/${encodeURIComponent(pid)}`
                : "/"
          }
        >
          ← {credential ? "对战大厅" : text.back}
        </a>
        {credential && (
          <a href="/duel/decks" target="_blank" rel="noreferrer">
            卡组
          </a>
        )}
        <details>
          <summary>{"卡图设置"}</summary>
          <LocalPicsSetting />
        </details>
        <button onClick={() => setShowHistory(true)}>对局记录</button>
        <strong>
          {mode === "player"
            ? text.title
            : mode === "watch"
              ? text.watch
              : text.replay}
        </strong>

        <span
          className={`duel-status ${status === "connected" ? "online" : ""}`}
        >
          {(text as any)[status] ?? status}
        </span>
      </header>
      <RoomDeletedDialog missing={error === "MATCH_NOT_FOUND"} />
      {error && error !== "MATCH_NOT_FOUND" && (
        <div className="duel-error" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setError("");
              setAttempt((a) => a + 1);
            }}
          >
            {text.reconnect}
          </button>
        </div>
      )}
      <div
        className={`duel-layout ${["lobby", "hand", "turn", "waitingTurn", "starting"].includes(state.stage) ? "pre-duel" : ""}`}
      >
        <aside className="duel-sidebar">
          <h2>{text.chain}</h2>
          {state.chain.map((c, i) => (
            <button key={i} onClick={() => c.code && openDetail(c.code, c.ref)}>
              #{i + 1} {cardName(c.code ?? 0)}
            </button>
          ))}
          <h2>{text.log}</h2>
          <div className="duel-log">
            {state.logs.slice(-35).map((l, i) => (
              <p key={i}>{formatLog(l)}</p>
            ))}
          </div>
        </aside>
        <div className={`duel-table ${placePrompt ? "selecting-zones" : ""}`}>
          <div className="duel-scoreboard">
            {[own, opponent].map((player) => (
              <div
                key={player}
                className={`duel-score ${state.turnPlayer === player ? "active" : ""}`}
              >
                <div className="duel-lp-track">
                  <i
                    style={{
                      width: `${Math.min(100, state.lp[player] / 80)}%`,
                    }}
                  />
                  <LifePoints value={state.lp[player]} />
                </div>
                <span>{state.names[player]}</span>
                <small>
                  {state.time[player]
                    ? `${Math.max(0, Math.floor(state.time[player] - (state.timePlayer === player ? elapsed : 0)))}秒`
                    : ""}
                </small>
              </div>
            ))}
          </div>
          {mode === "player" && state.stage === "dueling" && (
            <div
              className={`duel-priority ${state.prompt ? "is-own" : ""} ${placePrompt ? "duel-zone-instruction" : ""}`}
              role="status"
            >
              {placePrompt ? (
                <>
                  <strong>
                    {zoneSubmitted.current
                      ? "已选择，等待处理…"
                      : "点击发光的场地区域"}
                  </strong>
                  <span>
                    {selected.length} / {Math.max(1, placePrompt.min)} ·{" "}
                    {"选满确认"}
                  </span>
                  {placePrompt.cancel && (
                    <button
                      disabled={zoneSubmitted.current || decisionDisabled}
                      onClick={cancelSelection}
                    >
                      {text.cancel}
                    </button>
                  )}
                </>
              ) : state.prompt?.kind === "chain" ? (
                "轮到你响应：请选择卡片或效果"
              ) : state.prompt ? (
                "轮到你操作"
              ) : (
                "等待对方操作"
              )}
              {state.prompt?.kind === "chain" &&
                state.prompt.cancel &&
                !chainConfirmation && (
                  <button
                    disabled={decisionDisabled || chainPassedId === revision}
                    onClick={passChain}
                  >
                    取消响应
                  </button>
                )}
            </div>
          )}
          <div className="duel-phase">
            <span>第 {state.turn} 回合</span>
            <strong>
              {text.phases[phaseCodes.indexOf(state.phase)] ?? "—"}
            </strong>
            <div className="duel-phase-track">
              {[
                { code: 1, name: "抽卡" },
                { code: 2, name: "准备" },
                { code: 4, name: "主要一" },
                { code: 8, name: "战斗", label: "battle" },
                { code: 256, name: "主要二", label: "main2" },
                { code: 512, name: "结束", label: "end" },
              ].map((phase) => {
                const choice =
                  mode === "player" && state.prompt?.kind === "command"
                    ? state.prompt.choices.find(
                        (c) => c.label === phase.label && !!phase.label,
                      )
                    : undefined;
                const current =
                  phase.code === state.phase ||
                  (phase.code === 8 && [16, 32, 64, 128].includes(state.phase));
                return (
                  <button
                    key={phase.code}
                    disabled={!choice}
                    className={current ? "current" : ""}
                    aria-current={current ? "step" : undefined}
                    aria-label={`${phase.name}阶段`}
                    onClick={() => choice && choose(state.prompt!, choice)}
                  >
                    {phase.name}
                  </button>
                );
              })}
            </div>
            {state.winner !== undefined && (
              <span>
                {state.winner < 2 ? state.names[state.winner] : "平局"} ✓
              </span>
            )}
          </div>
          <div className="duel-hand opponent-hand" data-hand-player={opponent}>
            {state.cards
              .filter((c) => c.player === opponent && c.location === 2)
              .map((c) => cardButton(c, true))}
            <span>
              {zoneName(2)} ·{" "}
              {
                state.cards.filter(
                  (c) => c.player === opponent && c.location === 2,
                ).length
              }
            </span>
          </div>
          {state.winner !== undefined && (
            <div
              className={`duel-outcome ${state.winner === own ? "victory" : "defeat"}`}
              role="status"
            >
              <strong>
                {state.winner > 1
                  ? "平局"
                  : mode === "player"
                    ? state.winner === own
                      ? "胜利"
                      : "落败"
                    : `${state.names[state.winner]} 获胜`}
              </strong>
              <span>{victoryReasons[state.winReason ?? -1] ?? "特殊胜利"}</span>
            </div>
          )}
          {row(opponent)}
          <div className="duel-center-stage">
            {sharedExtras}
            {effect && (
              <div
                key={effect.id}
                className={`duel-effect-animation effect-${effect.kind}`}
                style={{ animationDuration: `${500 * effect.scale}ms` }}
                role="status"
                aria-live="polite"
              >
                {!!effect.code && (
                  <CardImage
                    code={effect.code}
                    name={cardName(effect.code)}
                    className="duel-effect-art"
                  />
                )}
                <div>
                  <strong>
                    {
                      {
                        activate: "效果发动",
                        formed: "连锁形成",
                        resolve: "连锁处理中",
                        solved: "处理完成",
                        negated: "效果无效",
                        end: "连锁结束",
                      }[effect.kind]
                    }
                  </strong>
                  {!!effect.index && <b>连锁 {effect.index}</b>}
                  {!!effect.code && <span>{cardName(effect.code)}</span>}
                </div>
              </div>
            )}
          </div>
          {row(own)}
          <div className="duel-hand" data-hand-player={own}>
            {state.cards
              .filter((c) => c.player === own && c.location === 2)
              .map((c) => cardButton(c))}
          </div>
          <BattleFeedback visuals={feedback.visuals} names={state.names} />
        </div>
        <aside className="duel-controls">
          {state.chain.length > 0 && (
            <div className="duel-chain-strip">
              {[...state.chain].reverse().map((c, i) => (
                <button
                  data-card-code={c.code}
                  onClick={() => c.code && openDetail(c.code, c.ref)}
                  key={c.index ?? i}
                  className={effect?.index === c.index ? "active" : ""}
                >
                  ⛓ {c.index} · {cardName(c.code ?? 0)}
                </button>
              ))}
            </div>
          )}
          {state.revealed?.length > 0 && (
            <details className="duel-revealed" open>
              <summary>{"展示卡片"}</summary>
              {state.revealed.map((code, i) => (
                <button
                  key={i}
                  data-card-code={code}
                  onClick={() => {
                    setShowRevealed(true);
                    setHoverCard(code);
                  }}
                >
                  <CardImage
                    code={code}
                    name={cardName(code)}
                    className="duel-reveal-art"
                  />
                  {cardName(code)}
                </button>
              ))}
            </details>
          )}
          {mode === "player" && (
            <>
              <div className="duel-toolbar">
                <select
                  aria-label={text.chain}
                  value={preference}
                  onChange={(e) =>
                    setPreference(e.target.value as ChainPreference)
                  }
                >
                  <option value="auto">{text.auto}</option>
                  <option value="available">有可用效果时响应</option>
                  <option value="always">{text.always}</option>
                  <option value="skip">{text.skip}</option>
                </select>
                <button onClick={() => setConfirmQuit(true)}>
                  {text.surrender}
                </button>
              </div>
              {state.stage === "lobby" && (
                <div className="duel-actions">
                  {credential && (
                    <RoomDeckPicker
                      disabled={
                        deckSubmitting ||
                        !lobbyJoined ||
                        !!state.ready[state.seat]
                      }
                      onError={setError}
                      onChoose={(d) => {
                        setError("");
                        setDeckSubmitting(true);
                        action(2, encodeDeck([...d.main, ...d.extra], d.side));
                      }}
                    />
                  )}
                  {credential && (
                    <p role="status">
                      {deckSubmitting
                        ? "正在检查卡组…"
                        : `当前卡组：主卡/额外共 ${state.deck.main.length} 张 · 副卡 ${state.deck.side.length} 张${state.ready[state.seat] ? "（取消准备后可更换）" : ""}`}
                    </p>
                  )}
                  <button
                    disabled={
                      !lobbyJoined ||
                      deckSubmitting ||
                      (!!credential && !state.deck.main.length)
                    }
                    onClick={() =>
                      action(state.ready[state.seat] ? 0x23 : 0x22)
                    }
                  >
                    {state.ready[state.seat] ? text.unready : text.ready}
                  </button>
                  {state.host && (
                    <button
                      disabled={!state.ready.every(Boolean)}
                      onClick={() => action(0x25)}
                    >
                      {text.start}
                    </button>
                  )}
                </div>
              )}
              {state.handResult &&
                ["hand", "turn", "waitingTurn"].includes(state.stage) && (
                  <div className="duel-rps-result" role="status">
                    <span aria-label={"我方"}>
                      {["", "✌️", "✊", "✋"][state.handResult[0]]}
                    </span>
                    <b>VS</b>
                    <span aria-label={"对方"}>
                      {["", "✌️", "✊", "✋"][state.handResult[1]]}
                    </span>
                    <small>
                      {state.handResult[0] === state.handResult[1]
                        ? "平局，请重新出拳"
                        : "猜拳结果"}
                    </small>
                  </div>
                )}
              {state.stage === "hand" && (
                <section className="duel-choice-stage">
                  <h2>{choiceSent ? "已出拳，等待对方" : "请选择你的手势"}</h2>
                  <div className="duel-gesture-grid">
                    {[1, 2, 3].map((v) => (
                      <button
                        key={v}
                        aria-label={(text as any)[`hand${v}`]}
                        aria-pressed={choiceSent === v}
                        disabled={choiceSent !== null}
                        className={choiceSent === v ? "chosen" : ""}
                        onClick={() => {
                          setChoiceSent(v);
                          action(3, Uint8Array.of(v));
                        }}
                      >
                        <span aria-hidden="true">
                          {["", "✌️", "✊", "✋"][v]}
                        </span>
                        <b>{(text as any)[`hand${v}`]}</b>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {state.stage === "turn" && (
                <section className="duel-choice-stage">
                  <h2>
                    {choiceSent !== null
                      ? "已提交，等待开始"
                      : "选择先攻或后攻"}
                  </h2>
                  <div className="duel-turn-grid">
                    {[1, 0].map((v) => (
                      <button
                        key={v}
                        disabled={choiceSent !== null}
                        aria-pressed={choiceSent === v}
                        aria-label={v ? text.first : text.second}
                        onClick={() => {
                          setChoiceSent(v);
                          action(4, Uint8Array.of(v));
                        }}
                      >
                        <svg viewBox="0 0 100 70" aria-hidden="true">
                          <rect x="14" y="8" width="38" height="54" rx="5" />
                          <rect x="48" y="8" width="38" height="54" rx="5" />
                          <text x={v ? 33 : 67} y="43">
                            1
                          </text>
                        </svg>
                        <b>{v ? text.first : text.second}</b>
                        <small>
                          {v ? "先行动，建立场面" : "后行动，回应对手"}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {["waitingTurn", "waitingSide", "starting"].includes(
                state.stage,
              ) && (
                <div className="duel-wait" role="status">
                  <span className="duel-pulse" /> {"等待对手完成选择…"}
                </div>
              )}
              {state.prompt && state.prompt.kind !== "place" && (
                <section
                  className={`duel-prompt ${centralPrompt && !fieldPicking ? "duel-central-prompt" : ""}`}
                  role={centralPrompt && !fieldPicking ? "dialog" : undefined}
                  aria-label={centralPrompt ? "请选择操作" : undefined}
                >
                  {centralPrompt && (
                    <div className="duel-prompt-heading">
                      <strong>轮到你选择</strong>
                      {canPickField && (
                        <button onClick={() => setFieldPicking((v) => !v)}>
                          {fieldPicking ? "打开选择窗口" : "在场上选择"}
                        </button>
                      )}
                    </div>
                  )}
                  {!centralPrompt && (
                    <button
                      className="duel-collapse"
                      onClick={() => setCollapsed((v) => !v)}
                    >
                      {collapsed ? "▴" : "▾"}
                    </button>
                  )}
                  <h2>
                    {centralPrompt
                      ? state.prompt.kind === "position"
                        ? "选择表示形式"
                        : state.prompt.message === 14
                          ? "选择效果"
                          : state.prompt.kind === "yesno"
                            ? "请确认"
                            : state.prompt.kind === "chain"
                              ? "选择必须发动的效果"
                              : ((text as any)[state.prompt.kind] ??
                                text.select)
                      : `${text.select} · ${(text as any)[state.prompt.kind] ?? text.select}`}{" "}
                    {selectionRange(state.prompt)}
                  </h2>
                  {(state.prompt.hint || state.prompt.message === 12) && (
                    <p>
                      {state.prompt.kind === "yesno"
                        ? effectQuestion(
                            state.prompt,
                            descriptions,
                            cardName,
                            zoneName,
                          )
                        : formatSystemText(
                            descriptions[state.prompt.hint ?? 0],
                            [],
                            text.select,
                          )}
                    </p>
                  )}
                  {state.prompt.target !== undefined && (
                    <p>Σ {state.prompt.target}</p>
                  )}
                  {(state.prompt.mandatory ?? []).map((c, i) => (
                    <p key={i}>
                      {text.required}: {cardName(c.code ?? 0)} (
                      {c.weight! & 65535})
                    </p>
                  ))}
                  <div
                    className="duel-choices"
                    style={
                      collapsed ||
                      chainConfirmation ||
                      (centralPrompt && fieldPicking)
                        ? { display: "none" }
                        : undefined
                    }
                  >
                    {state.prompt.choices
                      .map((c) => ({ ...c, code: choiceCode(c) }))
                      .filter(
                        (c) =>
                          !["battle", "main2", "end"].includes(c.label ?? "") &&
                          !(playable && c.ref && !centralPrompt),
                      )
                      .map((c, i) => (
                        <div
                          className={`duel-choice ${selected.includes(c.index) || c.selected ? "chosen" : ""}`}
                          key={i}
                        >
                          <button
                            className="duel-choice-main"
                            disabled={
                              decisionDisabled ||
                              !state.prompt ||
                              state.prompt.kind === "counter" ||
                              (![
                                "command",
                                "yesno",
                                "chain",
                                "position",
                                "unselect",
                              ].includes(state.prompt.kind) &&
                                toggleSelection(
                                  state.prompt,
                                  selected,
                                  c.index,
                                ) === selected)
                            }
                            onClick={() => choose(state.prompt!, c)}
                          >
                            {c.code ? (
                              <CardImage
                                code={c.code}
                                name={cardName(c.code)}
                                className={`duel-choice-image ${state.prompt?.kind === "position" ? `position-choice position-${c.value}` : ""}`}
                              />
                            ) : null}
                            <span>
                              {label(c, text)} {c.code ? cardName(c.code) : ""}
                              {c.ref && (
                                <small>
                                  {state.names[c.ref.player]} ·{" "}
                                  {zoneName(c.ref.location & 127)}{" "}
                                  {c.ref.sequence + 1}
                                </small>
                              )}
                              {c.description && (
                                <small>
                                  {formatSystemText(
                                    descriptions[c.description],
                                    [cardName(c.code ?? 0)],
                                    "选择此效果",
                                  )}
                                </small>
                              )}
                              {c.weight !== undefined && (
                                <small>
                                  {c.weight & 65535}
                                  {c.weight >>> 16
                                    ? ` / ${c.weight >>> 16}`
                                    : ""}
                                </small>
                              )}
                              {state.prompt?.kind === "sort" &&
                                selected.includes(c.index) && (
                                  <b>#{selected.indexOf(c.index) + 1}</b>
                                )}
                            </span>
                          </button>
                          {!!c.code && (
                            <button
                              className="duel-info"
                              onClick={() => openDetail(c.code!, c.ref)}
                            >
                              ⓘ
                            </button>
                          )}
                          {state.prompt?.kind === "counter" && (
                            <input
                              type="number"
                              disabled={decisionDisabled}
                              min={0}
                              max={c.weight}
                              value={amounts[i] ?? 0}
                              onChange={(e) =>
                                setAmounts((a) =>
                                  a.map((v, k) =>
                                    k === i ? Number(e.target.value) : v,
                                  ),
                                )
                              }
                            />
                          )}
                        </div>
                      ))}
                  </div>
                  {state.prompt.kind === "declare" && (
                    <>
                      <input
                        placeholder={text.search}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {results.map((c) => (
                        <button
                          key={c.code}
                          disabled={decisionDisabled}
                          onClick={() => respond(integer(c.code))}
                        >
                          {c.name}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="duel-actions">
                    {![
                      "command",
                      "yesno",
                      "chain",
                      "position",
                      "unselect",
                      "declare",
                    ].includes(state.prompt.kind) && (
                      <button
                        disabled={
                          decisionDisabled ||
                          !selectionValid(state.prompt, selected, amounts)
                        }
                        onClick={finishSelection}
                      >
                        {text.confirm}
                        {state.prompt.kind !== "counter" &&
                          ` (${selected.length})`}
                      </button>
                    )}
                    {canCancelSelection(state.prompt, selected.length) && (
                      <button
                        disabled={
                          decisionDisabled ||
                          (state.prompt.kind === "chain" &&
                            chainPassedId === revision)
                        }
                        onClick={() =>
                          state.prompt?.kind === "chain"
                            ? passChain()
                            : cancelSelection()
                        }
                      >
                        {state.prompt.kind === "chain"
                          ? "取消响应"
                          : state.prompt.kind === "unselect" &&
                              promptDetails.current.get(state.prompt)
                                ?.finishable
                            ? text.confirm
                            : text.cancel}
                      </button>
                    )}
                  </div>
                </section>
              )}
              {!state.prompt &&
                !["lobby", "hand", "turn", "siding"].includes(state.stage) && (
                  <p className="duel-waiting">{text.waiting}</p>
                )}
            </>
          )}
          {mode === "replay" && recording && (
            <section className="duel-replay-controls">
              {!recording.complete && <p>{text.incomplete}</p>}
              <div className="duel-actions">
                <button onClick={() => setPlaying((v) => !v)}>
                  {playing ? text.pause : text.play}
                </button>
                <button
                  onClick={() =>
                    seek(Math.min(recording.frames.length, cursor + 1))
                  }
                >
                  {text.step}
                </button>
                <select
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  {[0.5, 1, 2, 4, 8].map((v) => (
                    <option key={v} value={v}>
                      {v}×
                    </option>
                  ))}
                </select>
              </div>
              <input
                aria-label="Replay timeline"
                type="range"
                min={0}
                max={recording.frames.length}
                value={cursor}
                onChange={(e) => {
                  setPlaying(false);
                  seek(Number(e.target.value));
                }}
              />
              <p>
                {cursor} / {recording.frames.length}
              </p>
              <div className="duel-actions">
                {recording.frames
                  .map((f, i) => ({ f, i }))
                  .filter(({ f }) => {
                    const b = decode(f.frame);
                    return b[2] === 1 && b[3] === 4;
                  })
                  .map(({ i }, n) => (
                    <button key={i} onClick={() => seek(i + 1)}>
                      Game {n + 1}
                    </button>
                  ))}
              </div>
            </section>
          )}
        </aside>
        <aside className="duel-inspector" aria-label="卡片详情">
          {hoverCard ? (
            <>
              <CardImage
                code={hoverCard}
                name={cardName(hoverCard)}
                className="duel-inspector-art"
              />
              <h2>{cardName(hoverCard)}</h2>
              {!!((metadata[hoverCard]?.type ?? 0) & 1) && (
                <p>
                  {hoveredEntity ? "当前 " : ""}攻击{" "}
                  {
                    monsterStatus(
                      hoveredEntity ?? ({ code: hoverCard } as Card),
                      metadata[hoverCard],
                    ).atk
                  }{" "}
                  /{" "}
                  {(hoveredEntity?.type ?? metadata[hoverCard]?.type ?? 0) &
                  0x4000000
                    ? "连接"
                    : "守备"}{" "}
                  {
                    monsterStatus(
                      hoveredEntity ?? ({ code: hoverCard } as Card),
                      metadata[hoverCard],
                    ).def
                  }
                </p>
              )}
              {metadata[hoverCard] && (
                <CardMeta card={metadata[hoverCard]} compact />
              )}
              <p className="duel-inspector-text">{metadata[hoverCard]?.desc}</p>
            </>
          ) : (
            <span>卡片详情</span>
          )}
        </aside>
      </div>
      {!!hoverCard && state.stage === "siding" && (
        <aside
          className="duel-side-hover"
          style={{ left: hoverPoint.x, top: hoverPoint.y }}
          aria-label="换备卡片详情"
        >
          <CardImage
            code={hoverCard}
            name={cardName(hoverCard)}
            className="duel-hover-art"
          />
          <strong>{cardName(hoverCard)}</strong>
          {metadata[hoverCard] && (
            <CardMeta card={metadata[hoverCard]} compact />
          )}
          <p>{metadata[hoverCard]?.desc}</p>
        </aside>
      )}
      {chainConfirmation &&
        chainInspectId === revision &&
        !materialRef &&
        detail === null &&
        !zone && (
          <div className="duel-chain-inspection">
            <span>轮到你响应</span>
            <button onClick={() => setChainInspectId(null)}>返回响应</button>
          </div>
        )}
      {chainConfirmation &&
        chainInspectId !== revision &&
        !materialRef &&
        detail === null &&
        !zone && (
          <div className="duel-modal duel-chain-confirmation">
            <section
              className="duel-dialog duel-chain-dialog"
              role="alertdialog"
              aria-modal="false"
              aria-labelledby="chain-confirm-title"
            >
              <span className="duel-priority-badge">轮到你响应</span>
              <h2 id="chain-confirm-title">
                {state.chain.length
                  ? "是否连锁发动卡片或效果？"
                  : "是否发动卡片或效果？"}
              </h2>
              <button onClick={() => setChainInspectId(revision)}>
                查看场面
              </button>
              <div className="duel-response-cards" aria-label="可以响应的卡片">
                {(state.prompt?.choices ?? [])
                  .filter(
                    (c, i, all) =>
                      all.findIndex(
                        (other) =>
                          sameCard(other.ref, c.ref) ||
                          (!other.ref &&
                            !c.ref &&
                            choiceCode(other) === choiceCode(c)),
                      ) === i,
                  )
                  .map((c) => (
                    <button
                      key={c.index}
                      type="button"
                      data-card-code={choiceCode(c)}
                      onFocus={() => setHoverCard(choiceCode(c))}
                      onClick={() => openDetail(choiceCode(c), c.ref)}
                    >
                      {choiceCode(c) ? (
                        <CardImage
                          code={choiceCode(c)}
                          name={cardName(choiceCode(c))}
                          className="duel-response-art"
                        />
                      ) : (
                        <span>？</span>
                      )}
                      <span>{cardName(choiceCode(c))}</span>
                    </button>
                  ))}
              </div>
              <div className="duel-actions">
                <button
                  disabled={
                    decisionDisabled ||
                    !state.prompt?.choices.length ||
                    chainPassedId === revision
                  }
                  onClick={() => {
                    if (responseGate.current.canSend(revision, state.prompt))
                      setChainAcceptedId(revision);
                  }}
                >
                  响应
                </button>
                <button
                  autoFocus
                  disabled={decisionDisabled || chainPassedId === revision}
                  onClick={passChain}
                >
                  不响应
                </button>
              </div>
            </section>
          </div>
        )}
      {operationChoices && state.prompt && (
        <div
          className={`duel-modal duel-operation-modal ${!operationRegion ? "duel-context-modal" : ""}`}
          onClick={() => setOperationChoices(null)}
        >
          <section
            className={`duel-dialog duel-operation-dialog ${!operationRegion ? "duel-context-menu" : ""}`}
            style={
              !operationRegion && operationAnchor ? operationAnchor : undefined
            }
            role="dialog"
            aria-modal={operationRegion}
            aria-label={operationRegion ? "请选择要操作的卡片" : "选择操作"}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="duel-close"
              onClick={() => setOperationChoices(null)}
            >
              关闭
            </button>
            {state.prompt.kind === "chain" && state.prompt.cancel && (
              <button
                disabled={decisionDisabled || chainPassedId === revision}
                onClick={passChain}
              >
                取消响应
              </button>
            )}
            <h2>
              {operationRegion
                ? "请选择要操作的卡片"
                : cardName(choiceCode(operationChoices[0]))}
            </h2>
            {operationRegion && operationChoices[0]?.ref && (
              <button
                onClick={() => {
                  const ref = operationChoices[0].ref!;
                  setOperationChoices(null);
                  setZone({ player: ref.player, location: ref.location & 127 });
                }}
              >
                查看该区域全部卡片
              </button>
            )}
            <div className="duel-operation-grid">
              {operationChoices.map((c) => (
                <button
                  key={c.index}
                  className={`duel-operation ${pendingOperation?.index === c.index ? "chosen" : ""}`}
                  disabled={decisionDisabled}
                  aria-label={operationLabel(c)}
                  data-card-code={choiceCode(c)}
                  onMouseEnter={() => setHoverCard(choiceCode(c))}
                  onFocus={() => setHoverCard(choiceCode(c))}
                  onClick={() => {
                    if (operationRegion) setPendingOperation(c);
                    else {
                      choose(state.prompt!, c);
                      setOperationChoices(null);
                    }
                  }}
                >
                  {operationRegion && c.ref && (
                    <small className="duel-source-tag">
                      {zoneName(c.ref.location & 127)} [{c.ref.sequence + 1}]
                    </small>
                  )}
                  {operationRegion && !!choiceCode(c) && (
                    <CardImage
                      code={choiceCode(c)}
                      name={cardName(choiceCode(c))}
                      className="duel-operation-image"
                    />
                  )}
                  <span>
                    {operationLabel(c)}{" "}
                    {operationRegion ? cardName(choiceCode(c)) : ""}
                  </span>
                  {!!c.description && (
                    <small>
                      {formatSystemText(
                        descriptions[c.description],
                        [cardName(choiceCode(c))],
                        "发动效果",
                      )}
                    </small>
                  )}
                </button>
              ))}
            </div>
            {operationRegion && (
              <div className="duel-actions">
                <button
                  disabled={decisionDisabled || !pendingOperation}
                  onClick={() => {
                    if (pendingOperation) {
                      choose(state.prompt!, pendingOperation);
                      setOperationChoices(null);
                    }
                  }}
                >
                  确定
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {state.stage === "siding" && side && mode === "player" && (
        <div className="duel-modal">
          <section className="duel-dialog">
            <h2>{text.siding}</h2>
            {state.winner !== undefined && (
              <p className="duel-side-result" role="status">
                上一局：
                {state.winner > 1
                  ? "平局"
                  : state.winner === own
                    ? "胜利"
                    : "落败"}{" "}
                · {victoryReasons[state.winReason ?? -1] ?? "特殊胜利"}
              </p>
            )}
            <p>点击卡片移入或移出备选卡组</p>
            {(["main", "extra", "side"] as const).map((area) => {
              const loc = area === "extra" ? "main" : area;
              const cards = side[loc]
                .map((code, i) => ({ code, i }))
                .filter(
                  ({ code }) =>
                    area === "side" ||
                    !!(
                      (metadata[code]?.type ?? 0) &
                      (0x40 | 0x2000 | 0x800000 | 0x4000000)
                    ) ===
                      (area === "extra"),
                );
              return (
                <div
                  key={area}
                  className="duel-side-section"
                  data-deck-area={area}
                >
                  <h3>
                    {text[area]} ({cards.length})
                  </h3>
                  <div className="duel-side-grid">
                    {cards.map(({ code, i }) => (
                      <button
                        key={i}
                        data-card-code={code}
                        aria-label={cardName(code)}
                        onClick={() =>
                          setSide((d) => {
                            if (!d) return d;
                            const next = {
                              main: [...d.main],
                              side: [...d.side],
                            };
                            next[loc].splice(i, 1);
                            next[loc === "main" ? "side" : "main"].push(code);
                            return next;
                          })
                        }
                      >
                        <CardImage
                          code={code}
                          name={cardName(code)}
                          className="duel-image"
                        />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <button
              disabled={[...side.main, ...side.side].some(
                (code) => !metadata[code],
              )}
              onClick={() => action(2, encodeDeck(side.main, side.side))}
            >
              {text.submitSide}
            </button>
          </section>
        </div>
      )}
      {materialRef &&
        (() => {
          const host = state.cards.find((c) => sameCard(c, materialRef));
          const materialChoices = (state.prompt?.choices ?? []).filter(
            (c) =>
              c.ref &&
              sameCard(
                { ...c.ref, location: c.ref.location & 127 },
                materialRef,
              ) &&
              !!(c.ref.location & 128),
          );
          return (
            <div
              className="duel-modal duel-material-viewer"
              onClick={() => setMaterialRef(null)}
            >
              <section
                className="duel-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="超量素材"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="duel-close"
                  autoFocus
                  onClick={() => setMaterialRef(null)}
                >
                  关闭
                </button>
                <h2>超量素材（{host?.materials.length ?? 0}）</h2>
                {host && (
                  <p>
                    {cardName(host.code)} · 怪兽区 {host.sequence + 1}
                  </p>
                )}
                <div className="duel-material-list">
                  {host?.materials.map((code, sub) => (
                    <button
                      key={sub}
                      type="button"
                      data-card-code={code}
                      aria-label={`素材 ${sub + 1}：${cardName(code)}`}
                      aria-pressed={materialChoices.some(
                        (c) => c.ref?.sub === sub && selected.includes(c.index),
                      )}
                      className={
                        materialChoices.some(
                          (c) =>
                            c.ref?.sub === sub && selected.includes(c.index),
                        )
                          ? "card-chosen"
                          : ""
                      }
                      onFocus={() => setHoverCard(code)}
                      onClick={() => {
                        setHoverCard(code);
                        if (!chainConfirmation && state.prompt) {
                          const choice = state.prompt.choices.find((c) =>
                            sameCard(c.ref, {
                              ...materialRef,
                              location: materialRef.location | 128,
                              sub,
                            }),
                          );
                          if (choice) choose(state.prompt, choice);
                        }
                      }}
                    >
                      {code ? (
                        <CardImage
                          code={code}
                          name={cardName(code)}
                          className="duel-material-art"
                        />
                      ) : (
                        <span className="duel-back" />
                      )}
                      <span>{sub + 1}</span>
                    </button>
                  ))}
                </div>
                {!chainConfirmation &&
                  materialChoices.length > 0 &&
                  state.prompt &&
                  ["cards", "tribute", "sum"].includes(state.prompt.kind) && (
                    <button
                      disabled={
                        decisionDisabled ||
                        !selectionValid(state.prompt, selected, amounts)
                      }
                      onClick={() => {
                        finishSelection();
                        setMaterialRef(null);
                      }}
                    >
                      确认素材（{selected.length}）
                    </button>
                  )}
                <div className="duel-material-description">
                  <h3>
                    {host?.materials.includes(hoverCard)
                      ? cardName(hoverCard)
                      : "卡片详情"}
                  </h3>
                  <p>
                    {host?.materials.includes(hoverCard)
                      ? metadata[hoverCard]?.desc
                      : ""}
                  </p>
                </div>
              </section>
            </div>
          );
        })()}
      {(detail !== null || zone) && !materialRef && (
        <div
          className="duel-modal"
          onClick={() => {
            setDetail(null);
            setZone(null);
          }}
        >
          <section className="duel-dialog" onClick={(e) => e.stopPropagation()}>
            <button
              className="duel-close"
              onClick={() => {
                setDetail(null);
                setZone(null);
              }}
            >
              {text.close} ✕
            </button>
            {detail !== null ? (
              <>
                <h2>{cardName(detail)}</h2>
                <CardImage
                  code={detail}
                  name={cardName(detail)}
                  className="duel-detail-image"
                />
                {metadata[detail] && <CardMeta card={metadata[detail]} />}
                <p className="duel-description">{metadata[detail]?.desc}</p>
                {state.cards
                  .filter(
                    (c) =>
                      c.code === detail &&
                      (!detailRef || sameCard(c, detailRef)),
                  )
                  .map((c, i) => (
                    <div key={i}>
                      {c.materials.length > 0 && (
                        <button onClick={() => setMaterialRef(c)}>
                          查看超量素材（{c.materials.length}）
                        </button>
                      )}
                      {Object.keys(c.counters).length > 0 && (
                        <p>
                          {text.counter}: {JSON.stringify(c.counters)}
                        </p>
                      )}
                      {c.equip && (
                        <p>
                          ↗ {zoneName(c.equip.location)} {c.equip.sequence + 1}
                        </p>
                      )}
                    </div>
                  ))}
                {cardActions(state.prompt, detailRef)
                  .filter((c) => !chainConfirmation && c.code === detail)
                  .map((c, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        choose(state.prompt!, c);
                        setDetail(null);
                      }}
                    >
                      {label(c, text) || text.select}{" "}
                      {c.description
                        ? formatSystemText(
                            descriptions[c.description],
                            [cardName(c.code ?? 0)],
                            "选择此效果",
                          )
                        : ""}
                    </button>
                  ))}
              </>
            ) : (
              <>
                <h2>
                  {zoneName(zone!.location)} · {state.names[zone!.player]}
                </h2>
                <div className="duel-zone-browser">
                  {state.cards
                    .filter(
                      (c) =>
                        c.player === zone!.player &&
                        c.location === zone!.location &&
                        !(graveLocked && zone!.location === 16),
                    )
                    .map((c) => cardButton(c, false, true))}
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {showHistory && (
        <div className="duel-modal duel-history-modal">
          <section className="duel-dialog" role="dialog" aria-label="对局记录">
            <button
              className="duel-close"
              onClick={() => setShowHistory(false)}
            >
              关闭
            </button>
            <h2>本局记录</h2>
            <div className="duel-history-list">
              {state.logs.map((line, i) => {
                const codes = logCardCodes(line);
                const content = formatLog(line);
                return content ? (
                  <div key={i}>
                    <p>{content}</p>
                    {codes.map((code) => (
                      <button
                        key={code}
                        data-card-code={code}
                        onClick={() => {
                          setShowHistory(false);
                          openDetail(code);
                        }}
                      >
                        <CardImage
                          code={code}
                          name={cardName(code)}
                          className="duel-history-art"
                        />
                        {cardName(code)}
                      </button>
                    ))}
                  </div>
                ) : null;
              })}
            </div>
          </section>
        </div>
      )}
      {showRevealed && !!state.revealed?.length && (
        <div className="duel-modal duel-reveal-modal">
          <section className="duel-dialog" role="dialog" aria-label="展示卡片">
            <button
              className="duel-close"
              onClick={() => setShowRevealed(false)}
            >
              关闭
            </button>
            <h2>展示卡片</h2>
            <div className="duel-reveal-grid">
              {state.revealed.map((code, i) => (
                <button
                  key={i}
                  data-card-code={code}
                  onClick={() => {
                    setShowRevealed(false);
                    openDetail(code);
                  }}
                >
                  <CardImage
                    code={code}
                    name={cardName(code)}
                    className="duel-reveal-art"
                  />
                  <span>{cardName(code)}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {confirmQuit && (
        <div className="duel-modal">
          <section className="duel-dialog">
            <h2>{text.confirmSurrender}</h2>
            <div className="duel-actions">
              <button
                onClick={() => {
                  action(0x14);
                  setConfirmQuit(false);
                }}
              >
                {text.confirm}
              </button>
              <button onClick={() => setConfirmQuit(false)}>
                {text.close}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
