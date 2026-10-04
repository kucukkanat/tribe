import { IdentitySetup } from "../components/IdentitySetup";
import { Logo } from "../components/icons";
import { startDemo, useApp } from "../lib/state";

function Knots() {
  // A loose weave of threads: entries tied together by links.
  const lines = Array.from({ length: 9 }, (_, i) => {
    const y = 40 + i * 62;
    const a = 26 + (i % 3) * 14;
    return `M -20 ${y} C 160 ${y - a}, 300 ${y + a}, 460 ${y} S 760 ${y - a}, 920 ${y}`;
  });
  return (
    <svg class="knots" viewBox="0 0 900 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="1" opacity="0.13">{lines.map((d) => <path d={d} />)}</g>
      <g fill="none" stroke="#6fb594" stroke-width="1.4" opacity="0.6">
        <path d="M 120 102 C 220 160, 250 226, 330 288 S 520 400, 640 410" />
        <path d="M 640 410 C 700 360, 720 290, 800 226" />
      </g>
      <g fill="#6fb594">
        <circle cx="120" cy="102" r="4" /><circle cx="330" cy="288" r="4" /><circle cx="640" cy="410" r="5" /><circle cx="800" cy="226" r="4" />
      </g>
      <circle cx="520" cy="164" r="4" fill="#9aa3e6" />
      <path d="M 520 164 C 580 230, 600 330, 640 410" stroke="#9aa3e6" stroke-width="1.4" fill="none" opacity="0.6" stroke-dasharray="4 5" />
    </svg>
  );
}

export function Welcome() {
  const app = useApp();
  return (
    <div class="welcome">
      <section class="welcome-art">
        <Knots />
        <a class="brand" href="#/"><Logo size={24} />Tribe</a>
        <div>
          <h1>What your team knows, kept where your agents can read it.</h1>
          <p class="lede">Tribe is a shared memory for people and coding agents. Facts and pages are encrypted on your device and stored on public Nostr relays. Relays only ever see ciphertext.</p>
          <div class="facts">
            <div><span>✓</span><span>End-to-end encrypted with per-bucket keys</span></div>
            <div><span>✓</span><span>Agents pair as devices and write through MCP</span></div>
            <div><span>✓</span><span>No server and no account. Your key is your login</span></div>
          </div>
        </div>
      </section>
      <section class="welcome-side">
        <div class="stack">
          <h2>Look around first</h2>
          <p class="muted">The demo runs entirely in this tab with a seeded team bucket: conventions, incident learnings, agent-written facts and one open conflict.</p>
          <button class="btn primary lg block" disabled={app.demoSeeding} onClick={() => void startDemo()}>
            {app.demoSeeding ? "Preparing the demo…" : "Try the demo"}
          </button>
        </div>
        <div class="or">or set up your own identity</div>
        <IdentitySetup />
      </section>
    </div>
  );
}
