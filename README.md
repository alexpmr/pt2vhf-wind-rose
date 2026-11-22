# PT2VHF Wind Rose

A compact Home Assistant Lovelace card that shows **where the wind is coming from, how strong it is, and what it did over the last hour** — in one glance.

![PT2VHF Wind Rose in dark and light themes](images/preview.png)

The rose is a polar heat map:

- **angle** = direction the wind comes *from* (meteorological convention)
- **distance from the centre** = speed (calm in the middle, strong at the rim)
- **colour** = share of time the wind blew there (blue = rare → red = most of the time)

On top of it, a solid dot marks the current wind, a dashed ring marks the current gust and an arrow on the rim points in from the current direction. Beside the rose: current speed, direction (cardinal + degrees), gust, and for the window: prevailing direction, average, max and % of calm.

Works in light and dark themes, in English and Portuguese (follows the HA language), in masonry and Sections dashboards. In narrow columns (under ~300 px) the values move below the rose.

## Install

### Home Assistant Marketplace (2026.11+)

1. **Settings → Marketplace → Add from link**, enter `alexpmr/pt2vhf-wind-rose` (type **Dashboard** if asked). A GitHub connection is required.
2. Install **PT2VHF Wind Rose** and reload the browser. The Marketplace adds the dashboard resource for you (unless your resources are managed in YAML).

Older Home Assistant with HACS: add the same URL as a custom repository, type **Dashboard**.

### Manual

Copy `pt2vhf-wind-rose-card.js` to `config/www/`, then add a dashboard resource `/local/pt2vhf-wind-rose-card.js` (type *JavaScript module*).

## Configuration

```yaml
type: custom:pt2vhf-wind-rose-card
entity: sensor.wind_speed            # required – wind speed
direction_entity: sensor.wind_bearing # required – direction in degrees (0 = N)
gust_entity: sensor.wind_gust        # optional
name: Wind                           # optional
hours: 1                             # history window (default 1)
```

| Option | Default | Description |
| --- | --- | --- |
| `entity` | — | Wind speed sensor. Its unit is shown as is. |
| `direction_entity` | — | Wind direction sensor, numeric degrees. |
| `gust_entity` | — | Gust sensor (optional). |
| `rain_entity` | — | Rain sensor (optional): a `binary_sensor` (`on`) or a numeric rate/amount (> 0). Shows a "Raining" badge only while it rains. |
| `tap_action` | `more-info` | Standard Home Assistant action on tap (`more-info` of the speed sensor by default, `navigate`, `none`, …). |
| `name` | — | Title above the values. |
| `hours` | `1` | Window of history used for the heat map. |
| `max_speed` | auto | Speed at the rim. Auto picks a round value above the window's peak. |
| `sectors` | `16` | Direction bins: 8, 16 or 32. |
| `rings` | `5` | Speed bins from centre to rim. |
| `calm` | `0.5` | Speeds below this count as calm (not drawn, shown as %). |
| `smooth` | `2` | Blur of the heat map (0 = sharp cells). |
| `refresh` | `60` | Seconds between history reloads. |

The card reads history through the recorder (`history/history_during_period`), so both sensors must be recorded. Direction sensors that report text (e.g. `NW`) are not supported — use a numeric degree sensor.

## Development

```sh
node --test test/*.test.mjs   # unit tests for the binning math
```

`demo/index.html` renders the card with a simulated `hass` object; serve the folder with any static server and open it.

## License

MIT
