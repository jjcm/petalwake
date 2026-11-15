// Pointer capture keeps independent steering and action fingers alive outside their buttons.
export class TouchControls {
  constructor(input, game) {
    this.input = input; this.game = game;
    this.mode = new URLSearchParams(location.search).get('touch') || 'auto';
    this.pointers = new Map();
    this.coarse = matchMedia('(any-pointer: coarse)');
    const root = this.root = document.createElement('div');
    root.id = 'touch-controls'; root.hidden = true;
    root.innerHTML = `<div class="touch-stick" role="group" aria-label="Drag to bank, up to climb, down to dive"><span class="touch-knob"></span><small>steer</small></div>
      <div class="touch-actions"><button data-hold="boost">Boost</button><button data-hold="brake">Brake<br><small>2× land</small></button></div>
      <div class="touch-tools"><button data-code="KeyC">Camera</button><button data-code="KeyQ">Flip</button><button data-journal>Journal</button></div>`;
    document.body.append(root);
    this.stick = root.querySelector('.touch-stick');
    this.knob = root.querySelector('.touch-knob');
    this.bind(this.stick, 'stick');
    for (const button of root.querySelectorAll('[data-hold]')) this.bind(button, button.dataset.hold);
    for (const button of root.querySelectorAll('[data-code]')) button.addEventListener('click', () => { if (!game.paused) input.touchAction(button.dataset.code); });
    root.querySelector('[data-journal]').addEventListener('click', () => {
      this.reset();
      const journal = game.places?.journal;
      if (journal?.canOpen()) journal.toggle();
    });
    this.coarse.addEventListener('change', () => this.refresh());
    window.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' && !this.detected) { this.detected = true; this.refresh(); }
    });
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
    this.refresh();
  }

  bind(element, action) {
    element.addEventListener('pointerdown', e => {
      if (!this.input.enabled || this.game.paused || e.button > 0) return;
      if (action === 'stick' && [...this.pointers.values()].some(p => p.action === 'stick')) return;
      e.preventDefault();
      element.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { action, element });
      element.classList.add('held');
      if (action === 'stick') this.move(e);
      else {
        this.input.touch[action] = true;
        if (action === 'brake') this.input.touchAction('Space', e.timeStamp);
      }
    });
    element.addEventListener('pointermove', e => this.move(e));
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(name, e => this.release(e.pointerId));
  }

  move(e) {
    if (this.pointers.get(e.pointerId)?.action !== 'stick') return;
    const rect = this.stick.getBoundingClientRect(), radius = rect.width * 0.35;
    let x = (e.clientX - rect.left - rect.width / 2) / radius;
    let y = (e.clientY - rect.top - rect.height / 2) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) { x /= length; y /= length; }
    // Screen up climbs, like the mouse/gamepad. Keep a small neutral zone.
    const response = v => Math.abs(v) < 0.08 ? 0 : Math.sign(v) * (Math.abs(v) - 0.08) / 0.92;
    this.input.touch.x = response(x); this.input.touch.y = -response(y);
    this.knob.style.transform = `translate(${x * radius}px, ${y * radius}px)`;
  }

  release(id) {
    const pointer = this.pointers.get(id);
    if (!pointer) return;
    this.pointers.delete(id);
    if (![...this.pointers.values()].some(p => p.action === pointer.action)) {
      pointer.element.classList.remove('held');
      if (pointer.action === 'stick') {
        this.input.touch.x = this.input.touch.y = 0; this.knob.style.transform = '';
      } else this.input.touch[pointer.action] = false;
    }
  }

  reset() {
    for (const [id, { element }] of [...this.pointers]) {
      this.release(id);
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    }
    this.input.touch.x = this.input.touch.y = 0;
    this.input.touch.boost = this.input.touch.brake = false;
  }

  setMode(mode) { this.mode = mode; this.refresh(); }
  refresh() {
    const show = this.mode === 'on' || (this.mode !== 'off' && (this.coarse.matches || navigator.maxTouchPoints > 0 || this.detected));
    this.root.hidden = this.game.state !== 'play' || !show;
    document.body.classList.toggle('touch-layout', show);
    if (this.root.hidden) this.reset();
  }
}
