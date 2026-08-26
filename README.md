# Litra for Macotron

Control a [Logitech Litra](https://www.logitech.com/products/lighting) light
from the [Macotron](https://github.com/statico/macotron) menu bar.

- Click the lightbulb to turn the light on or off.
- Right-click or Control-click for brightness and color temperature.
- Run **Toggle Litra** from the launcher, or bind it to a hotkey.

The menu bar icon shows the state: filled when the light is on, hollow when it
is off, and struck through when no light is connected.

## Install

1. Open Macotron. Go to Settings → Plugins → Catalog → Community.
2. Find **Litra**. Press **Add**.
3. Read the source in the review sheet. Press **Add** again.

Macotron scans the plugin before it runs.

## Supported lights

| Model | Product ID |
|---|---|
| Litra Glow | `0xc900` |
| Litra Beam | `0xc901` |
| Litra Beam (older firmware) | `0xb901` |
| Litra Beam LX | `0xc903` |

Connect the light over USB. Bluetooth is not supported: the plugin speaks HID
to the device.

## How it works

The light speaks HID++ 2.0 on vendor usage page `0xff43`. Every exchange writes
a 20-byte short report and reads the reply off the interrupt pipe:

```js
if (!send(id, [0x11, 0xff, feat, 0x01])) return null;      // ask: are you on?
const ev = await macotron.hid.readInput(id, { timeout: 400 });
```

The device answers within microseconds, faster than the read can arm itself.
Macotron queues input reports from the moment `macotron.hid.open` returns, so
the reply is waiting when `readInput` runs. Needs Macotron with
`macotron.hid.readInput` returning a promise.

The state polls every two seconds and on `usb:changed`, which is what keeps the
menu bar right when the light is switched at the device.

## Debugging

Plugin output goes to the system log under the `plugin` category:

```sh
log stream --level info --style compact \
  --predicate 'subsystem == "io.statico.macotron" AND category == "plugin"'
```

Every command logs what it sent, and an exchange that gets no reply logs the
command it was waiting on.

## Credits

The HID++ command bytes come from the reverse engineering in
[litra](https://github.com/timrogers/litra) by Tim Rogers.

## License

MIT
