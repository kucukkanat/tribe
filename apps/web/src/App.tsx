import { useEffect } from "preact/hooks";
import { Toasts } from "./components/Toasts";
import { UnlockScreen } from "./components/IdentitySetup";
import { Logo } from "./components/icons";
import { boot, useApp } from "./lib/state";
import { go, useRoute } from "./lib/router";
import { toastError } from "./lib/toast";
import { Welcome } from "./screens/Welcome";
import { Buckets } from "./screens/Buckets";
import { CreateBucket } from "./screens/Create";
import { Join } from "./screens/Join";
import { Knowledge } from "./screens/Knowledge";
import { EntryScreen } from "./screens/Entry";
import { EditorScreen } from "./screens/Editor";
import { Members } from "./screens/Members";
import { Devices } from "./screens/Devices";
import { Settings } from "./screens/Settings";

function Loading({ text }: { text: string }) {
  return <div class="center-screen"><div class="unlock"><Logo size={36} style={{ color: "var(--moss)" }} /><p class="muted">{text}</p></div></div>;
}

export function App() {
  const app = useApp();
  const r = useRoute();
  useEffect(() => { boot().catch((e) => toastError(e, "Startup failed")); }, []);
  useEffect(() => { scrollTo(0, 0); }, [r.name, "entryId" in r ? r.entryId : ""]);

  // Redirects that depend on identity.
  useEffect(() => {
    if (app.phase === "ready" && (r.name === "home" || r.name === "welcome")) {
      const only = app.buckets?.length === 1 ? app.buckets[0] : null;
      if (app.buckets) go(only ? `/b/${only.bucketId}` : "/buckets");
    }
  }, [app.phase, r.name, app.buckets]);

  let view;
  if (app.phase === "boot") view = <Loading text={app.demoSeeding ? "Seeding the demo bucket…" : "Loading…"} />;
  else if (r.name === "join") view = <Join blob={r.blob} />;
  else if (app.phase === "locked") view = <UnlockScreen />;
  else if (app.phase === "needs-identity") view = <Welcome />;
  else switch (r.name) {
    case "home": case "welcome": view = <Loading text="Opening…" />; break;
    case "buckets": view = <Buckets />; break;
    case "create": view = <CreateBucket />; break;
    case "knowledge": view = <Knowledge bucketId={r.bucketId} />; break;
    case "entry": view = <EntryScreen bucketId={r.bucketId} entryId={r.entryId} />; break;
    case "edit": view = <EditorScreen bucketId={r.bucketId} entryId={r.entryId} />; break;
    case "new": view = <EditorScreen bucketId={r.bucketId} type={r.type} />; break;
    case "members": view = <Members bucketId={r.bucketId} />; break;
    case "devices": view = <Devices bucketId={r.bucketId} />; break;
    case "settings": view = <Settings bucketId={r.bucketId} />; break;
    default: view = <div class="center-screen"><div class="unlock"><h1>Page not found</h1><a class="btn" href="#/buckets">Go to your buckets</a></div></div>;
  }
  return <>{view}<Toasts /></>;
}
