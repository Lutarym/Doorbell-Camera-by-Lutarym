# Doorbell Camera Card by Lutarym

A Lovelace card for Home Assistant that counts doorbell presses and shows a camera image in fullscreen when someone rings.

## Features

- Shows how many times the doorbell was pressed today
- Lists the last 5 presses with date and time
- Counts only the press, not the release
- Tap the list or the history icon to open a popup with all presses of the last day, week, month or year
- Opens the camera image in fullscreen when the doorbell rings
- Display duration of the camera image is configurable
- Click on the camera image to close it
- Card name can be changed
- Snapshots of every press with timestamp in the history popup (requires the integration below)
- Full configuration in the visual card editor

## Snapshots

To store a camera snapshot of every press, install the integration [Event Snapshot Recorder by Lutarym](https://github.com/YOUR_GITHUB_USER/event-snapshot-recorder-by-lutarym) and set it up for the same doorbell entity. The card detects it automatically. With the integration the history is also kept for one year, independent of the recorder settings.

## Installation

### HACS (custom repository)

1. Open HACS in Home Assistant.
2. Open the menu (three dots, top right) and choose **Custom repositories**.
3. Add the URL of this repository and select the type **Dashboard**.
4. Search for **Doorbell Camera Card by Lutarym** and download it.
5. Reload your browser.

### Manual

1. Copy `dist/doorbell-camera-card-by-lutarym.js` to `/config/www/`.
2. Go to **Settings > Dashboards > Resources** and add `/local/doorbell-camera-card-by-lutarym.js` as **JavaScript module**.
3. Reload your browser.

## Configuration

Add the card to your dashboard and pick **Doorbell Camera Card by Lutarym**. All options can be set in the visual editor.

| Option          | Required | Default | Description                                  |
| --------------- | -------- | ------- | -------------------------------------------- |
| `name`          | no       | `Doorbell Camera Card by Lutarym` | Name shown on the card |
| `entity`        | yes      |         | Doorbell entity (`binary_sensor` or `event`) |
| `camera_entity` | no       |         | Camera entity shown in fullscreen            |
| `duration`      | no       | `30`    | Display time of the camera image in seconds  |

### YAML example

```yaml
type: custom:doorbell-camera-card-by-lutarym
name: Doorbell Camera Card by Lutarym
entity: binary_sensor.doorbell
camera_entity: camera.front_door
duration: 30
```

## Notes

- For `binary_sensor` and similar entities, only the change to `on` counts as a press.
- For `event` entities, every new event counts as a press.
- The fullscreen camera image only appears on devices where the dashboard with this card is currently open.
- Presses are loaded from the Home Assistant history of up to 365 days.
- Without the integration, presses come from the recorder history. By default the recorder keeps only 10 days of history. To see a full month or year, raise `purge_keep_days` in the recorder configuration.
