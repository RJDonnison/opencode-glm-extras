/**
 * @jsxImportSource @opentui/solid
 */
import { createComponent, createSignal, onCleanup } from "solid-js";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";

type SessionMessage = ReturnType<
  TuiPluginApi["state"]["session"]["messages"]
>[number];

/**
 * GLM Coding Plan rate periods (docs.z.ai/devpack):
 * Peak = Mon–Fri 14:00–18:00 UTC+8 at 1x credit rate.
 * Off-peak = all other hours, charged at 50% (0.5x) credits.
 * The `peak` window below is therefore the EXPENSIVE window; the
 * indicator counts down to/from it.
 */
type PeakConfig = {
  start: string;
  end: string;
  days: number[];
  utcOffsetMinutes: number;
};

type PromptNavConfig = {
  pageUp: string;
  pageDown: string;
};

type GlmExtrasOptions = {
  peak?: Partial<PeakConfig>;
  promptNav?: Partial<PromptNavConfig>;
};

const DEFAULT_PEAK: PeakConfig = {
  start: "14:00",
  end: "18:00",
  days: [1, 2, 3, 4, 5],
  utcOffsetMinutes: 480,
};

const DEFAULT_PROMPT_NAV: PromptNavConfig = {
  pageUp: "pageup",
  pageDown: "pagedown",
};

const TICK_MS = 30_000;
const STEP_DELAY_MS = 12;
const MAX_STEPS = 400;
const ANCHOR_SETTLE_MS = 30;

// ---------------------------------------------------------------------------
// Peak/off-peak indicator
// ---------------------------------------------------------------------------

function parseClock(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return fallback;
  return h * 60 + m;
}

function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type RateStatus = { peak: boolean; minutes: number };

function computeRate(cfg: PeakConfig, nowMs: number): RateStatus {
  const rawStart = parseClock(cfg.start, 840);
  const rawEnd = parseClock(cfg.end, 1080);
  const valid = rawStart < rawEnd;
  const startMin = valid ? rawStart : 840;
  const endMin = valid ? rawEnd : 1080;
  const days = new Set(cfg.days);
  const shifted = new Date(nowMs + cfg.utcOffsetMinutes * 60_000);
  const day = shifted.getUTCDay();
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();

  const peak = days.has(day) && minuteOfDay >= startMin && minuteOfDay < endMin;
  if (peak) return { peak: true, minutes: endMin - minuteOfDay };

  for (let addDays = 0; addDays < 8; addDays++) {
    const d = (day + addDays) % 7;
    if (!days.has(d)) continue;
    if (addDays === 0 && minuteOfDay >= startMin) continue;
    return { peak: false, minutes: addDays * 1440 + startMin - minuteOfDay };
  }
  return { peak: false, minutes: 0 };
}

function RatePanel(props: { api: TuiPluginApi; cfg: PeakConfig }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => clearInterval(timer));
  const status = () => computeRate(props.cfg, now());
  const color = () =>
    status().peak
      ? props.api.theme.current.warning
      : props.api.theme.current.success;
  const label = () =>
    status().peak
      ? `Peak 1x · ${formatDuration(status().minutes)} to off-peak`
      : `Off-peak 0.5x · ${formatDuration(status().minutes)} left`;
  return (
    <box gap={0}>
      <text fg={props.api.theme.current.text} wrapMode="none">
        GLM Off-Peak
      </text>
      <text fg={color()} wrapMode="none">
        {`● ${label()}`}
      </text>
    </box>
  );
}

function registerRatePanel(api: TuiPluginApi, cfg: PeakConfig): void {
  api.slots.register({
    order: 160,
    slots: {
      sidebar_content(_ctx) {
        return createComponent(RatePanel, { api, cfg });
      },
    },
  });
}

// ---------------------------------------------------------------------------
// PgUp/PgDn prompt navigation
// ---------------------------------------------------------------------------

type PromptCursor = { sessionID: string; promptID: string };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Mirrors the TUI's own visibility rule: at least one non-synthetic,
// non-ignored text part.
function visibleMessages(
  api: TuiPluginApi,
  sessionID: string,
): SessionMessage[] {
  return api.state.session.messages(sessionID).filter((message) => {
    const parts = api.state.part(message.id);
    return parts.some(
      (part) => part.type === "text" && !part.synthetic && !part.ignored,
    );
  });
}

type Nav = {
  cursor: PromptCursor | null;
  jump: (dir: -1 | 1) => Promise<void>;
  goTo: (
    sessionID: string,
    prompts: SessionMessage[],
    promptIdx: number,
  ) => Promise<void>;
};

function createPromptNav(api: TuiPluginApi): Nav {
  const nav: Nav = {
    cursor: null,
    async jump(dir) {
      const route = api.route.current as {
        name: string;
        params?: { sessionID?: string };
      };
      const sessionID =
        route.name === "session" ? route.params?.sessionID : undefined;
      if (typeof sessionID !== "string") return;

      const visible = visibleMessages(api, sessionID);
      const prompts = visible.filter((m) => m.role === "user");
      if (prompts.length === 0) return;

      const cursor = nav.cursor;
      const cursorIdx =
        cursor && cursor.sessionID === sessionID
          ? prompts.findIndex((m) => m.id === cursor.promptID)
          : -1;

      if (cursorIdx === -1) {
        if (dir === -1) {
          await nav.goTo(sessionID, prompts, prompts.length - 1);
        } else {
          nav.cursor = null;
          await api.keymap.dispatchCommand("session.last");
        }
        return;
      }

      const target = cursorIdx + dir;
      if (target < 0) {
        nav.cursor = null;
        await api.keymap.dispatchCommand("session.first");
        return;
      }
      if (target >= prompts.length) {
        nav.cursor = null;
        await api.keymap.dispatchCommand("session.last");
        return;
      }
      await nav.goTo(sessionID, prompts, target);
    },
    // Deterministic jump: anchor on the last user prompt (built-in command),
    // then step up one visible message at a time until reaching the target.
    async goTo(sessionID, prompts, promptIdx) {
      const target = prompts[promptIdx];
      if (!target) return;
      await api.keymap.dispatchCommand("session.messages_last_user");
      await sleep(ANCHOR_SETTLE_MS);

      const visible = visibleMessages(api, sessionID);
      const anchor = prompts[prompts.length - 1];
      const from = visible.findIndex((m) => m.id === anchor.id);
      const to = visible.findIndex((m) => m.id === target.id);
      if (from === -1 || to === -1 || from <= to) {
        nav.cursor = { sessionID, promptID: target.id };
        return;
      }
      const steps = Math.min(from - to, MAX_STEPS);
      for (let i = 0; i < steps; i++) {
        void api.keymap.dispatchCommand("session.message.previous");
        await sleep(STEP_DELAY_MS);
      }
      nav.cursor = { sessionID, promptID: target.id };
    },
  };
  return nav;
}

function registerPromptNav(api: TuiPluginApi, options: GlmExtrasOptions): void {
  const cfg = { ...DEFAULT_PROMPT_NAV, ...options.promptNav };
  const nav = createPromptNav(api);
  const dispose = api.keymap.registerLayer({
    mode: "base",
    priority: 300,
    enabled: () => api.route.current.name === "session",
    commands: [
      {
        name: "glm-extras.prompt.previous",
        title: "Jump to previous prompt",
        desc: "Scroll to the previous user prompt in this session",
        category: "GLM Extras",
        namespace: "palette",
        run: () => void nav.jump(-1),
      },
      {
        name: "glm-extras.prompt.next",
        title: "Jump to next prompt",
        desc: "Scroll to the next user prompt in this session",
        category: "GLM Extras",
        namespace: "palette",
        run: () => void nav.jump(1),
      },
    ],
    bindings: [
      {
        key: cfg.pageUp,
        cmd: "glm-extras.prompt.previous",
        desc: "Previous prompt",
      },
      { key: cfg.pageDown, cmd: "glm-extras.prompt.next", desc: "Next prompt" },
    ],
  });
  api.lifecycle.onDispose(dispose);
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export const tui: TuiPlugin = async (api, options) => {
  const opts = (options ?? {}) as GlmExtrasOptions;
  const peak = { ...DEFAULT_PEAK, ...opts.peak };
  registerRatePanel(api, peak);
  registerPromptNav(api, opts);
};

const module: TuiPluginModule = { id: "opencode-glm-extras", tui };
export default module;
