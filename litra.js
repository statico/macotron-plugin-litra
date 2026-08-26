// Litra — Logitech Litra light control for Macotron.
//
// Speaks HID++ 2.0 over the vendor usage page. Every exchange is: write a
// 20-byte short report, then read the reply off the interrupt pipe. The device
// answers in microseconds, so the reply is already queued by the time
// readInput runs — that is what the queue in macotron.hid.open is for.

macotron.plugin({
  title: "Litra",
  description: "Turn a Logitech Litra light on or off, and set brightness and color temperature.",
  help: "Click the lightbulb to toggle. Right-click or Control-click for brightness and color temperature.",
});

const VENDOR = 0x046d;
const USAGE_PAGE = 0xff43;
const TEMPS = [2700, 3200, 4000, 5000, 6500];
const PCTS = [20, 40, 60, 80, 100];
const REPLY_MS = 400;

let busy = false;
let snap = { connected: false, on: false, lumens: 0, kelvin: 5000, name: "Litra", pid: 0 };

// The HID++ feature index the light's own feature sits at. It is fixed per
// model, so there is no need to walk the feature table at connect time.
function feature(pid) {
  if (pid === 0xc903) return 6;
  if (pid === 0xc900 || pid === 0xc901 || pid === 0xb901) return 4;
  return 0;
}

function limits(pid) {
  if (pid === 0xc900) return { minLm: 20, maxLm: 250, minK: 2700, maxK: 6500 };
  return { minLm: 30, maxLm: 400, minK: 2700, maxK: 6500 };
}

function find() {
  const hits = macotron.hid.list({ vendorID: VENDOR }).filter((d) => feature(d.productID));
  return hits.find((d) => d.usagePage === USAGE_PAGE) || hits[0] || null;
}

function pad20(bytes) {
  const out = bytes.slice();
  while (out.length < 20) out.push(0);
  return out;
}

// A short HID++ report is report id 0x11. Some devices hand the id back in
// reportId with the payload stripped; others leave it in the data.
function hidpp(ev) {
  const data = ev && ev.data ? ev.data : [];
  const bytes = ev.reportId === 0x11 && data[0] !== 0x11 ? [0x11].concat(data) : data;
  return bytes[0] === 0x11 && bytes.length >= 5 ? bytes : null;
}

function send(id, bytes) {
  const result = macotron.hid.sendOutput(id, pad20(bytes), { length: 20 });
  if (!result.ok) console.error("litra: write failed:", result.error);
  return result.ok;
}

// Read until a report answers one of `cmds`, or the budget runs out. The light
// also sends unsolicited reports, so the first report on the wire is not
// always the reply to the question just asked.
async function ask(id, cmds, bytes) {
  if (!send(id, bytes)) return null;
  const deadline = Date.now() + REPLY_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const ev = await macotron.hid.readInput(id, { timeout: left });
    if (!ev) break;
    const reply = hidpp(ev);
    if (reply && cmds.indexOf(reply[3]) >= 0) return reply;
  }
  console.warn("litra: no reply to command", cmds.map((c) => c.toString(16)).join("/"));
  return null;
}

function u16(bytes) {
  return bytes[4] * 256 + bytes[5];
}

function be16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nearest(value, list) {
  return list.reduce((best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best));
}

function pctOf(lm, lim) {
  return Math.round((lm / lim.maxLm) * 100);
}

function lmFromPct(p, lim) {
  return clamp(Math.round((lim.maxLm * p) / 100), lim.minLm, lim.maxLm);
}

// Open, run, close. Holding the handle open across the 2s poll would keep the
// device claimed while the user is doing something else with it.
async function withLitra(fn) {
  const dev = find();
  if (!dev) return { connected: false };
  const h =
    macotron.hid.open({
      vendorID: dev.vendorID,
      productID: dev.productID,
      usagePage: USAGE_PAGE,
    }) || macotron.hid.open({ path: dev.path });
  if (!h) {
    console.error("litra: found", dev.name, "but could not open it");
    return { connected: true, ok: false };
  }
  try {
    return { connected: true, ok: true, value: await fn(h.id, feature(dev.productID), dev) };
  } finally {
    macotron.hid.close(h.id);
  }
}

async function query(id, feat, dev) {
  const on = await ask(id, [0x00, 0x01, 0x1c], [0x11, 0xff, feat, 0x01]);
  const brightness = await ask(id, [0x31, 0x4c], [0x11, 0xff, feat, 0x31]);
  const temperature = await ask(id, [0x81, 0x9c], [0x11, 0xff, feat, 0x81]);
  if (!on && !brightness && !temperature) return null;
  return {
    connected: true,
    on: on ? on[4] === 1 : snap.on,
    lumens: brightness ? u16(brightness) : snap.lumens,
    kelvin: temperature ? u16(temperature) : snap.kelvin,
    name: dev.name || "Litra",
    pid: dev.productID,
  };
}

function menu() {
  if (!snap.connected) return [{ title: "Not connected" }];
  const lim = limits(snap.pid);
  const pNear = nearest(pctOf(snap.lumens, lim), PCTS);
  const kNear = nearest(snap.kelvin, TEMPS);
  return [
    { title: snap.name + (snap.on ? " · On" : " · Off") },
    { title: snap.lumens + " lm  ·  " + snap.kelvin + " K" },
    "-",
    { title: snap.on ? "Turn Off" : "Turn On", onClick: () => setOn(!snap.on) },
    "-",
    {
      title: "Brightness",
      menu: [
        {
          buttons: [
            { title: "Dimmer", onClick: () => nudgeLm(-1) },
            { title: "Brighter", onClick: () => nudgeLm(1) },
          ],
        },
        "-",
        ...PCTS.map((p) => ({
          title: (p === pNear ? "✓ " : "") + p + "%",
          onClick: () => setLm(lmFromPct(p, lim)),
        })),
      ],
    },
    {
      title: "Temperature",
      menu: [
        {
          buttons: [
            { title: "Warmer", onClick: () => nudgeK(-1) },
            { title: "Cooler", onClick: () => nudgeK(1) },
          ],
        },
        "-",
        ...TEMPS.map((k) => ({
          title: (k === kNear ? "✓ " : "") + k + " K",
          onClick: () => setK(k),
        })),
      ],
    },
  ];
}

function paint() {
  macotron.menubar.status("litra-light", {
    title: "",
    sfSymbol: !snap.connected ? "lightbulb.slash" : snap.on ? "lightbulb.fill" : "lightbulb",
    onClick: toggle,
    menu: menu(),
  });
  macotron.checks([
    {
      title: "Litra",
      ok: snap.connected,
      message: !snap.connected
        ? "Not connected"
        : (snap.on ? "On" : "Off") + " · " + snap.lumens + " lm · " + snap.kelvin + " K",
    },
  ]);
}

// One exchange at a time. Two overlapping open/write/read sequences on the
// same device read each other's replies.
async function locked(fn) {
  while (busy) await macotron.sleep(20);
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

async function refresh() {
  if (busy) return;
  await locked(async () => {
    const result = await withLitra(query);
    if (!result.connected || !result.ok || !result.value) {
      if (snap.connected) console.log("litra: disconnected");
      snap = { connected: false, on: false, lumens: 0, kelvin: snap.kelvin, name: "Litra", pid: 0 };
    } else {
      if (!snap.connected) {
        console.log("litra: connected to", result.value.name, "pid", result.value.pid.toString(16));
      }
      snap = result.value;
      snap.connected = true;
    }
    paint();
  });
}

async function act(fn) {
  await locked(async () => {
    const result = await withLitra(fn);
    if (!result.connected) {
      snap.connected = false;
      macotron.notify.toast("Litra", "Not connected", {
        color: "error",
        sfSymbol: "lightbulb.slash",
      });
    } else if (!result.ok || result.value == null) {
      console.error("litra: command did not take");
      macotron.notify.toast("Litra", "Could not update the light", { color: "error" });
    } else {
      snap = result.value;
      snap.connected = true;
    }
    paint();
  });
}

// The light echoes the old value if it is read too soon after a write, so each
// setter overwrites the field it just set with what it asked for.
function setOn(on) {
  console.log("litra: turning", on ? "on" : "off");
  return act(async (id, feat, dev) => {
    if (!send(id, [0x11, 0xff, feat, 0x1c, on ? 1 : 0])) return null;
    const next = await query(id, feat, dev);
    if (next) next.on = on;
    return next;
  });
}

function setLm(lm) {
  const lim = limits(snap.pid);
  const value = clamp(Math.round(lm), lim.minLm, lim.maxLm);
  console.log("litra: brightness", value, "lm");
  return act(async (id, feat, dev) => {
    if (!send(id, [0x11, 0xff, feat, 0x4c].concat(be16(value)))) return null;
    const next = await query(id, feat, dev);
    if (next) next.lumens = value;
    return next;
  });
}

function setK(k) {
  const lim = limits(snap.pid);
  const value = clamp(Math.round(k / 100) * 100, lim.minK, lim.maxK);
  console.log("litra: temperature", value, "K");
  return act(async (id, feat, dev) => {
    if (!send(id, [0x11, 0xff, feat, 0x9c].concat(be16(value)))) return null;
    const next = await query(id, feat, dev);
    if (next) next.kelvin = value;
    return next;
  });
}

function nudgeLm(dir) {
  const lim = limits(snap.pid);
  const step = Math.max(10, Math.round((lim.maxLm - lim.minLm) / 10));
  return setLm(snap.lumens + dir * step);
}

function nudgeK(dir) {
  return setK(snap.kelvin + dir * 100);
}

function toggle() {
  return setOn(!snap.on);
}

console.log("litra: loaded");
paint();
refresh();
macotron.every(2000, refresh);
macotron.on("usb:changed", refresh);

macotron.command("Toggle Litra", "Turn the Litra on or off", toggle, { id: "litra/toggle" });
