/* Doorbell Camera Card by Lutarym für Home Assistant
 * Zeigt, wie oft heute geklingelt wurde, und die letzten 5 Klingelzeiten.
 * Bei einem Klingeln erscheint das Kamerabild im Vollbild.
 */

const HISTORY_DAYS = 10;
const MAX_ENTRIES = 5;
const INVALID = ["unavailable", "unknown", "", null, undefined];

const LABELS = {
  entity: "Klingel Entität",
  camera_entity: "Kamera Entität",
  duration: "Anzeigedauer Kamerabild (Sekunden)",
};

class DoorbellCameraCard extends HTMLElement {
  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: {} } },
        { name: "camera_entity", selector: { entity: { domain: "camera" } } },
        {
          name: "duration",
          selector: { number: { min: 1, max: 600, step: 1, mode: "box" } },
        },
      ],
      computeLabel: (schema) => LABELS[schema.name] || schema.name,
    };
  }

  static getStubConfig() {
    return { entity: "", camera_entity: "", duration: 30 };
  }

  constructor() {
    super();
    this._config = {};
    this._presses = [];
    this._loadedFor = null;
    this._prevState = undefined;
    this._lastValid = undefined;
    this._overlay = null;
    this._overlayTimer = null;
    this._tick = null;
  }

  setConfig(config) {
    const entityChanged = !this._config || this._config.entity !== config.entity;
    this._config = { duration: 30, ...config };
    if (entityChanged) {
      this._presses = [];
      this._loadedFor = null;
      this._prevState = undefined;
      this._lastValid = undefined;
    }
    this._render();
  }

  connectedCallback() {
    // Einmal pro Minute neu zeichnen, damit der Zähler um Mitternacht stimmt
    this._tick = setInterval(() => this._render(), 60000);
    this._render();
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    this._closeOverlay();
  }

  set hass(hass) {
    this._hass = hass;
    const id = this._config.entity;
    if (!id) return;
    const st = hass.states[id];
    if (!st) {
      this._render();
      return;
    }

    if (this._loadedFor !== id) {
      this._loadedFor = id;
      this._loadHistory(id);
      this._render();
    }

    const prev = this._prevState;
    const cur = st.state;
    this._prevState = cur;
    if (cur === prev) return;

    let pressed = false;
    if (id.startsWith("event.")) {
      // Event Entität: jeder neue Zeitstempel ist ein Klingeln
      if (!INVALID.includes(cur)) {
        if (prev !== undefined && this._lastValid !== undefined && cur !== this._lastValid) {
          pressed = true;
        }
        this._lastValid = cur;
      }
    } else {
      // Alle anderen: nur der Wechsel auf "on" zählt (gedrückt), "off" (losgelassen) wird ignoriert
      pressed = prev !== undefined && cur === "on";
    }

    if (pressed) {
      const ts = new Date(st.last_changed).getTime() || Date.now();
      this._addPresses([ts]);
      this._showCamera();
    }
  }

  async _loadHistory(id) {
    try {
      const start = new Date(Date.now() - HISTORY_DAYS * 86400000);
      const res = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: new Date().toISOString(),
        entity_ids: [id],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      if (this._config.entity !== id) return;
      const list = (res && res[id]) || [];
      const isEvent = id.startsWith("event.");
      const found = [];
      let prev;
      let lastValid;
      list.forEach((item, index) => {
        const s = item.s;
        const ts = (item.lc !== undefined ? item.lc : item.lu) * 1000;
        if (isEvent) {
          if (!INVALID.includes(s)) {
            if (index > 0 && lastValid !== undefined && s !== lastValid) found.push(ts);
            lastValid = s;
          }
        } else if (index > 0 && s === "on" && prev !== "on") {
          found.push(ts);
        }
        prev = s;
      });
      this._addPresses(found);
    } catch (err) {
      console.error("doorbell-camera-card-by-lutarym: Verlauf konnte nicht geladen werden", err);
    }
  }

  _addPresses(list) {
    const all = this._presses.concat(list).sort((a, b) => a - b);
    const clean = [];
    for (const ts of all) {
      // Doppelte Einträge (Verlauf und Live Erkennung) entfernen
      if (!clean.length || ts - clean[clean.length - 1] > 1000) clean.push(ts);
    }
    this._presses = clean;
    this._render();
  }

  _showCamera() {
    const cam = this._config.camera_entity;
    if (!cam || !this._hass) return;
    const camState = this._hass.states[cam];
    if (!camState) return;
    this._closeOverlay();

    const token = camState.attributes.access_token;
    const url = this._hass.hassUrl(
      `/api/camera_proxy_stream/${cam}?token=${encodeURIComponent(token)}`
    );

    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#000;display:flex;" +
      "align-items:center;justify-content:center;cursor:pointer;";
    const img = document.createElement("img");
    img.src = url;
    img.style.cssText = "width:100%;height:100%;object-fit:contain;";
    overlay.appendChild(img);
    overlay.addEventListener("click", () => this._closeOverlay());
    document.body.appendChild(overlay);
    this._overlay = overlay;

    const seconds = Number(this._config.duration) > 0 ? Number(this._config.duration) : 30;
    this._overlayTimer = setTimeout(() => this._closeOverlay(), seconds * 1000);
  }

  _closeOverlay() {
    clearTimeout(this._overlayTimer);
    this._overlayTimer = null;
    if (this._overlay) {
      const img = this._overlay.querySelector("img");
      if (img) img.src = "";
      this._overlay.remove();
      this._overlay = null;
    }
  }

  _esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  _render() {
    if (!this._config) return;
    const id = this._config.entity;
    const st = id && this._hass ? this._hass.states[id] : undefined;

    let body;
    if (!id) {
      body = `<div class="hint">Bitte eine Klingel Entität auswählen.</div>`;
    } else if (this._hass && !st) {
      body = `<div class="hint">Entität nicht gefunden: ${this._esc(id)}</div>`;
    } else {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const today = this._presses.filter((ts) => ts >= midnight.getTime()).length;
      const last = this._presses.slice(-MAX_ENTRIES).reverse();
      const fmt = new Intl.DateTimeFormat("de-DE", {
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const rows = last.length
        ? last.map((ts) => `<li>${this._esc(fmt.format(new Date(ts)))} Uhr</li>`).join("")
        : `<li class="hint">Noch kein Klingeln aufgezeichnet.</li>`;
      body = `
        <div class="count"><span>${today}</span> mal heute geklingelt</div>
        <div class="sub">Letzte ${MAX_ENTRIES} Klingelzeiten</div>
        <ul>${rows}</ul>`;
    }

    const title = "Doorbell Camera Card by Lutarym";
    this.innerHTML = `
      <ha-card header="${this._esc(title)}">
        <style>
          .tk { padding: 0 16px 16px; }
          .tk .count { font-size: 1.1em; }
          .tk .count span { font-size: 2em; font-weight: 500; margin-right: 6px; }
          .tk .sub { margin-top: 12px; color: var(--secondary-text-color); }
          .tk ul { list-style: none; margin: 6px 0 0; padding: 0; }
          .tk li { padding: 6px 0; border-bottom: 1px solid var(--divider-color); }
          .tk li:last-child { border-bottom: none; }
          .tk .hint { color: var(--secondary-text-color); }
        </style>
        <div class="tk">${body}</div>
      </ha-card>`;
  }

  getCardSize() {
    return 4;
  }
}

if (!customElements.get("doorbell-camera-card-by-lutarym")) {
  customElements.define("doorbell-camera-card-by-lutarym", DoorbellCameraCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "doorbell-camera-card-by-lutarym",
  name: "Doorbell Camera Card by Lutarym",
  description: "Zählt Klingeln, zeigt die letzten 5 Zeiten und blendet das Kamerabild im Vollbild ein.",
});
