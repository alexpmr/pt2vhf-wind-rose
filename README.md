# PT2VHF Wind Rose

A compact Home Assistant Lovelace card that shows **where the wind is coming from, how strong it is, and what it did over the last hour** — in one glance.

![PT2VHF Wind Rose in dark and light themes](images/preview.png)

The rose is a continuous polar heat map (a smooth density of every sample, with no sector or ring edges):

- **angle** = direction the wind comes *from* (meteorological convention)
- **distance from the centre** = speed (calm in the middle, strong at the rim)
- **colour** = share of time the wind blew there (blue = rare → red = most of the time)

On top of it, a large arrow on the rim points in from the current direction, a solid dot marks the current wind and a dashed ring the current gust. The rose fills the card; the numbers sit quietly in the corners: current speed (and a rain note), direction, gust, and the window's prevailing direction and max.

Works in light and dark themes, in English and Portuguese (follows the HA language), in masonry and Sections dashboards. Everything scales with the card width.

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
window: 1h                           # heat-map window: 15m, 30m, 1h, 6h, 24h…
pointer: arrow                       # arrow | chevron | dart | needle | compass | vane | none
```

| Option | Default | Description |
| --- | --- | --- |
| `entity` | — | Wind speed sensor. Its unit is shown as is. |
| `direction_entity` | — | Wind direction sensor, numeric degrees. |
| `gust_entity` | — | Gust sensor (optional). |
| `rain_entity` | — | Rain sensor (optional): a `binary_sensor` (`on`) or a numeric rate/amount (> 0). Shows a "rain" note only while it rains. |
| `tap_action` | `more-info` | Standard Home Assistant action on tap (`more-info` of the speed sensor by default, `navigate`, `none`, …). |
| `name` | Wind | Label of the speed corner. |
| `window` | `1h` | History window of the heat map: minutes or hours, e.g. `15m`, `30m`, `1h`, `1.5h`, `24h` (a plain number = minutes). |
| `hours` | `1` | Older way to set the window in whole hours; ignored when `window` is set. |
| `direction_offset` | `0` | Rotates the whole rose clockwise by this many degrees (N/E/S/W labels, grid, heat map and pointer) so it matches how the viewer faces the dashboard. Display only: measured values and the direction text stay true. |
| `max_speed` | auto | Speed at the rim. Auto picks a round value above the window's peak. |
| `sectors` | `16` | Direction bins used for the prevailing direction: 8, 16 or 32. |
| `rings` | `5` | Number of speed circles drawn on the grid (never changes the heat map). |
| `show_guide` | `true` | Dashed line from the arrow to the centre (`arrow` pointer only). |
| `show_speed` | `true` | Solid dot at the current speed, in the current direction (distance from the centre = speed). |
| `show_gust` | `true` | Dashed ring at the current gust, same direction and scale (needs `gust_entity`). |
| `show_rim` | `true` | Show the outer circle (the rose outline). |
| `show_rings` | `true` | Show the inner speed circles. |
| `show_spokes` | `true` | Show the 8 radial lines. |
| `show_scale` | `true` | Show the rim speed label. |
| `pointer` | `arrow` | Current-direction pointer. All mark the side the wind comes from: `arrow` (triangle on the rim + guide line), `chevron` (open V on the rim), `dart` (slim notched arrowhead on the rim), `needle` (compass needle through the centre), `compass` (wide arrow from the rim to the centre), `vane` (weather vane across the rose: feathers on the "from" side, head where the wind blows to) or `none`. |
| `pointer_color` | text colour | Any CSS colour for the pointer, e.g. `#e8553e` or `var(--accent-color)`. |
| `calm` | `0.5` | Speeds below this count as calm and are left out of the heat map. |
| `max_width` | `380` | Maximum size of the rose in px on wide cards. |
| `smooth` | `8` | Spread of each sample in the heat map, in % of the radius (lower = more detail, higher = softer). |
| `refresh` | `60` | Seconds between history reloads. |

The card reads history through the recorder (`history/history_during_period`), so both sensors must be recorded. Direction sensors that report text (e.g. `NW`) are not supported — use a numeric degree sensor.

## Development

```sh
node --test test/*.test.mjs   # unit tests for the rose and density math
```

`demo/index.html` renders the card with a simulated `hass` object; serve the folder with any static server and open it.

## License

MIT
