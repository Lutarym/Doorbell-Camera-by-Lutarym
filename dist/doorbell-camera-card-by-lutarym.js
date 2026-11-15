/* Doorbell Camera Card by Lutarym für Home Assistant
 * Zeigt, wie oft heute geklingelt wurde, und die letzten 5 Klingelzeiten.
 * Bei einem Klingeln erscheint das Kamerabild im Vollbild.
 * Mit der Integration "Event Snapshot Recorder by Lutarym" werden zusätzlich
 * Kamerabilder gespeichert und im Protokoll angezeigt.
 */

const HISTORY_DAYS = 365;
const MAX_ENTRIES = 5;
const PERIODS = [
  { key: "day", label: "1 Tag", days: 1 },
  { key: "week", label: "1 Woche", days: 7 },
  { key: "month", label: "1 Monat", days: 30 },
  { key: "year", label: "1 Jahr", days: 365 },
];
const INVALID = ["unavailable", "unknown", "", null, undefined];

const DEFAULT_NAME = "Doorbell Camera Card by Lutarym";
const WS_TYPE = "lutarym_event_snapshot_recorder/presses";

const LABELS = {
  name: "Name der Karte",
  entity: "Klingel Entität",
  camera_entity: "Kamera Entität",
  duration: "Anzeigedauer Kamerabild (Sekunden)",
};

class DoorbellCameraCard extends HTMLElement {
  static getConfigForm() {
    return {
      schema: [
        { name: "name", selector: { text: {} } },
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
    return { name: DEFAULT_NAME, entity: "", camera_entity: "", duration: 30 };
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
    this._log = null;
    this._escHandler = null;
    this._period = "day";
    this._images = new Set();
    this._entryId = null;
    this._viewImage = null;
  }

  setConfig(config) {
    const entityChanged = !this._config || this._config.entity !== config.entity;
    this._config = { duration: 30, ...config };
    if (entityChanged) {
      this._presses = [];
      this._images = new Set();
      this._entryId = null;
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
    this._closeLog();
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
      if (this._entryId) {
        // Bild wird von der Integration gespeichert, danach Protokoll neu laden
        setTimeout(() => this._loadIntegration(id), 4000);
        setTimeout(() => this._loadIntegration(id), 15000);
      }
    }
  }

  async _loadIntegration(id) {
    try {
      const res = await this._hass.callWS({ type: WS_TYPE, entity_id: id });
      if (this._config.entity !== id) return true;
      this._entryId = res.entry_id;
      this._images = new Set(res.presses.filter((p) => p.image).map((p) => p.ts));
      this._addPresses(res.presses.map((p) => p.ts));
      return true;
    } catch (err) {
      return false;
    }
  }

  async _loadHistory(id) {
    // Mit installierter Integration kommen Protokoll und Bilder von dort
    if (await this._loadIntegration(id)) return;
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

  _fmt(ts, withWeekday) {
    const d = new Date(ts);
    const date = new Intl.DateTimeFormat("de-DE", {
      weekday: withWeekday ? "short" : undefined,
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    }).format(d);
    const time = new Intl.DateTimeFormat("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
    return { date, time };
  }

  _row(ts) {
    const f = this._fmt(ts, true);
    const cam = this._images.has(ts)
      ? `<button class="cam" data-img="${ts}" title="Bild anzeigen"><ha-icon icon="mdi:camera"></ha-icon></button>`
      : `<span class="cam"></span>`;
    return `<li><span class="d">${this._esc(f.date)}</span><span class="t">${this._esc(f.time)}</span>${cam}</li>`;
  }

  _render() {
    if (!this._config) return;
    const id = this._config.entity;
    const st = id && this._hass ? this._hass.states[id] : undefined;
    const title = this._config.name || DEFAULT_NAME;

    let today = 0;
    let body;
    if (!id) {
      body = `<div class="hint">Bitte eine Klingel Entität auswählen.</div>`;
    } else if (this._hass && !st) {
      body = `<div class="hint">Entität nicht gefunden: ${this._esc(id)}</div>`;
    } else {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      today = this._presses.filter((ts) => ts >= midnight.getTime()).length;
      const last = this._presses.slice(-MAX_ENTRIES).reverse();
      body = last.length
        ? `<ul>${last.map((ts) => this._row(ts)).join("")}</ul>`
        : `<div class="hint">Noch kein Klingeln aufgezeichnet.</div>`;
    }

    const logBtn =
      this._presses.length > MAX_ENTRIES
        ? `<button class="log" data-action="log" title="Protokoll"><ha-icon icon="mdi:history"></ha-icon></button>`
        : "";

    this.innerHTML = `
      <ha-card>
        <style>
          .dc { padding: 10px 12px; font-size: 0.9em; }
          .dc .head { display: flex; align-items: center; gap: 8px; }
          .dc .head ha-icon { --mdc-icon-size: 20px; color: var(--primary-color); }
          .dc .title { flex: 1; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .dc .badge { background: var(--primary-color); color: var(--text-primary-color, #fff);
            border-radius: 10px; padding: 1px 8px; font-size: 0.85em; white-space: nowrap; }
          .dc .log { background: none; border: none; padding: 2px; cursor: pointer; line-height: 0; }
          .dc ul { list-style: none; margin: 6px 0 0; padding: 0; }
          .dc li { display: flex; align-items: center; gap: 8px; padding: 2px 0;
            border-bottom: 1px solid var(--divider-color); }
          .dc li .d { flex: 1; }
          .dc .cam { width: 22px; height: 22px; background: none; border: none; padding: 0;
            cursor: pointer; line-height: 0; color: var(--primary-color); }
          .dc .cam ha-icon { --mdc-icon-size: 18px; }
          .dc li:last-child { border-bottom: none; }
          .dc .hint { margin-top: 6px; color: var(--secondary-text-color); }
        </style>
        <div class="dc">
          <div class="head">
            <ha-icon icon="mdi:doorbell"></ha-icon>
            <span class="title">${this._esc(title)}</span>
            <span class="badge">${today} heute</span>
            ${logBtn}
          </div>
          ${body}
        </div>
      </ha-card>`;

    const btn = this.querySelector("[data-action='log']");
    if (btn) btn.addEventListener("click", () => this._openLog());
    this.querySelectorAll("[data-img]").forEach((el) =>
      el.addEventListener("click", () => this._openLog(Number(el.dataset.img)))
    );
    if (this._log) this._renderLog();
  }

  _openLog(imageTs) {
    this._closeLog();
    this._viewImage = imageTs || null;
    const log = document.createElement("div");
    log.style.cssText =
      "position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.5);" +
      "display:flex;align-items:center;justify-content:center;";
    log.addEventListener("click", (e) => {
      if (e.target === log) this._closeLog();
    });
    this._escHandler = (e) => {
      if (e.key === "Escape") this._closeLog();
    };
    document.addEventListener("keydown", this._escHandler);
    document.body.appendChild(log);
    this._log = log;
    this._renderLog();
  }

  _renderLog() {
    if (!this._log) return;
    if (this._viewImage) {
      this._renderImage();
      return;
    }
    const period = PERIODS.find((p) => p.key === this._period) || PERIODS[0];
    const from = Date.now() - period.days * 86400000;
    const list = this._presses.filter((ts) => ts >= from).reverse();
    const tabs = PERIODS.map(
      (p) =>
        `<button class="tab${p.key === period.key ? " active" : ""}" data-period="${p.key}">${p.label}</button>`
    ).join("");
    const scroll = this._log.querySelector("ul");
    const scrollTop = scroll ? scroll.scrollTop : 0;

    this._log.innerHTML = `
      <style>
        .dcl { background: var(--card-background-color, #fff); color: var(--primary-text-color, #000);
          border-radius: 12px; width: min(420px, 92vw); max-height: 80vh; display: flex;
          flex-direction: column; padding: 12px 14px; font-family: var(--paper-font-body1_-_font-family, inherit);
          box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
        .dcl .top { display: flex; align-items: center; }
        .dcl .top b { flex: 1; }
        .dcl .x { background: none; border: none; font-size: 1.4em; cursor: pointer; color: inherit; line-height: 1; }
        .dcl .tabs { display: flex; gap: 6px; margin: 10px 0 6px; flex-wrap: wrap; }
        .dcl .tab { font: inherit; font-size: 0.9em; cursor: pointer; border-radius: 14px; padding: 4px 12px;
          border: 1px solid var(--primary-color, #03a9f4); background: none; color: var(--primary-color, #03a9f4); }
        .dcl .tab.active { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        .dcl .sum { color: var(--secondary-text-color, #666); font-size: 0.9em; margin-bottom: 4px; }
        .dcl ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
        .dcl li { display: flex; align-items: center; gap: 8px; padding: 4px 0;
          border-bottom: 1px solid var(--divider-color, #ddd); font-size: 0.9em; }
        .dcl li .d { flex: 1; }
        .dcl .cam { width: 24px; height: 24px; background: none; border: none; padding: 0;
          cursor: pointer; line-height: 0; color: var(--primary-color, #03a9f4); }
        .dcl .cam ha-icon { --mdc-icon-size: 20px; }
        .dcl li:last-child { border-bottom: none; }
      </style>
      <div class="dcl">
        <div class="top"><b>Klingelprotokoll</b><button class="x" data-action="close" title="Schließen">&times;</button></div>
        <div class="tabs">${tabs}</div>
        <div class="sum">${list.length} mal geklingelt (${period.label})</div>
        <ul>${
          list.length
            ? list.map((ts) => this._row(ts)).join("")
            : `<li><span>Kein Klingeln in diesem Zeitraum.</span></li>`
        }</ul>
      </div>`;

    const ul = this._log.querySelector("ul");
    if (ul) ul.scrollTop = scrollTop;
    this._log.querySelector("[data-action='close']").addEventListener("click", () => this._closeLog());
    this._log.querySelectorAll("[data-period]").forEach((el) =>
      el.addEventListener("click", () => {
        this._period = el.dataset.period;
        const u = this._log.querySelector("ul");
        if (u) u.scrollTop = 0;
        this._renderLog();
      })
    );
    this._log.querySelectorAll("[data-img]").forEach((el) =>
      el.addEventListener("click", () => {
        this._viewImage = Number(el.dataset.img);
        this._renderLog();
      })
    );
  }

  _renderImage() {
    const ts = this._viewImage;
    const f = this._fmt(ts, true);
    this._log.innerHTML = `
      <style>
        .dci { background: var(--card-background-color, #fff); color: var(--primary-text-color, #000);
          border-radius: 12px; width: min(900px, 94vw); max-height: 90vh; display: flex;
          flex-direction: column; padding: 12px 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
        .dci .top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .dci .top b { flex: 1; text-align: center; }
        .dci button { background: none; border: none; cursor: pointer; color: inherit; font: inherit; }
        .dci .x { font-size: 1.4em; line-height: 1; }
        .dci .back { color: var(--primary-color, #03a9f4); }
        .dci .img { display: flex; align-items: center; justify-content: center; min-height: 200px; }
        .dci img { max-width: 100%; max-height: 75vh; object-fit: contain; border-radius: 6px; }
        .dci .msg { color: var(--secondary-text-color, #666); }
      </style>
      <div class="dci">
        <div class="top">
          <button class="back" data-action="back">&lsaquo; Protokoll</button>
          <b>${this._esc(f.date)} ${this._esc(f.time)} Uhr</b>
          <button class="x" data-action="close" title="Schließen">&times;</button>
        </div>
        <div class="img"><span class="msg">Bild wird geladen</span></div>
      </div>`;
    this._log.querySelector("[data-action='close']").addEventListener("click", () => this._closeLog());
    this._log.querySelector("[data-action='back']").addEventListener("click", () => {
      this._viewImage = null;
      this._renderLog();
    });
    this._loadImage(ts);
  }

  async _loadImage(ts) {
    const box = this._log && this._log.querySelector(".img");
    try {
      // Bilder liegen geschützt in der Integration, Abruf nur mit kurzlebiger Signatur
      const res = await this._hass.callWS({
        type: "auth/sign_path",
        path: `/api/lutarym_event_snapshot_recorder/image/${this._entryId}/${ts}.jpg`,
        expires: 60,
      });
      if (!this._log || this._viewImage !== ts || !box) return;
      const img = document.createElement("img");
      img.alt = "Kamerabild";
      img.onload = () => box.replaceChildren(img);
      img.onerror = () => {
        box.innerHTML = `<span class="msg">Bild nicht mehr vorhanden.</span>`;
      };
      img.src = this._hass.hassUrl(res.path);
    } catch (err) {
      if (box) box.innerHTML = `<span class="msg">Bild konnte nicht geladen werden.</span>`;
    }
  }

  _closeLog() {
    if (this._escHandler) {
      document.removeEventListener("keydown", this._escHandler);
      this._escHandler = null;
    }
    if (this._log) {
      this._log.remove();
      this._log = null;
    }
    this._viewImage = null;
  }

  getCardSize() {
    return 3;
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
