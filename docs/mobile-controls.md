# Touchscreen controls

Controls appear automatically on touch devices once you take off. Use `?touch=on`
to force them on a hybrid device, or `?touch=off` to hide them when using a gamepad.
The game still requires a browser with WebGL2.

- Drag the left stick to bank; drag up to climb and down to dive. Pitch inversion
  (`I`) affects touch input too.
- Hold Boost or Brake while steering with another finger.
- Double-tap Brake within 300 ms to land at a highlighted landing place. Tap Brake
  once to take off. Holding it still brakes normally.
- Camera cycles the chase cameras, Flip requests a kickflip when unlocked, and
  Journal opens the treasure journal. Tap the journal page to close it.

Controls release when a pointer is cancelled or loses capture, the window loses
focus, or the page goes into the background. Touch does not request pointer lock.
The HUD respects display safe areas and makes room for the controls in portrait
and landscape. Keyboard, mouse and gamepad input can still be combined.

## Verification

With Node.js 22 or newer:

```sh
node --test tests/input.test.mjs tests/touch.test.mjs
```

These tests exercise input merging, inversion, landing taps, independent pointer
capture, cancellation, multi-finger holds, background reset and pointer-lock
gating. They use event/DOM test doubles, not a physical touchscreen or GPU.

Device checks before release: serve the game over HTTP; test Android Chrome and
iOS Safari in portrait and landscape; steer while boosting/braking; land and take
off; open/close the journal; background the page while holding a control; rotate
the screen; and verify desktop keyboard, mouse and gamepad input.
