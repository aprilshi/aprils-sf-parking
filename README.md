# SF Park Smart

Phone-friendly map of San Francisco street cleaning + parking meter hours/rates, with "I parked here" reminders.
Everything runs in the browser from static files, so there's no server, account, or API key.

## Data sources
| What | Source | Freshness |
|---|---|---|
| Street sweeping, every block side | DataSF `yhqp-riqs` (the data behind the Map of Street Sweeping Routes, `n8xs-xfw6`) | Public Works |
| Meter hours, hourly rates, time limits, tow-away | DataSF `qq7v-hds4` "Meter Policies" (SFMTA Meter API extract) | Updated daily; the app also fetches it live when you tap a meter |
| Meter locations | DataSF `8vzz-qzz9` "Parking Meters" | Weekly |
| Holidays: which ones suspend meters, nightly sweeping, daytime sweeping | [SFMTA Holiday Enforcement Schedule](https://www.sfmta.com/getting-around/drive-park/holiday-enforcement-schedule) (scraped by the build) | SFMTA publishes about a year ahead; after that the app estimates the City's 12 legal holidays |
| Address search | DataSF `3mea-di5p` Enterprise Addressing System (live), plus OpenStreetMap Nominatim for places and intersections | Live |

## Run locally
```sh
python3 scripts/build_data.py        # refresh data (≈1 min)
python3 -m http.server 8765 -d public
open http://localhost:8765
```

## Use it on your phone
Location access needs HTTPS, so deploy `public/` to any static host, for example:
- **Netlify Drop**: drag the `public` folder onto https://app.netlify.com/drop
- **GitHub Pages / Vercel / Cloudflare Pages**: publish the `public` directory

Then open the URL on your phone, choose **Share → Add to Home Screen**, and it behaves like an app.

## Keeping data fresh
`.github/workflows/deploy.yml` publishes to GitHub Pages on every push. Every Monday it also re-runs the data build, including holidays, before publishing.

## Reminders
- **📅 Add to Calendar**: downloads an `.ics` file with alerts, such as 60 min before sweeping, 8pm the night before, before the meter starts, and before the time limit runs out. This is the reliable option because your phone's calendar fires the alerts even when the app is closed.
- **🔔 Notifications**: in-app notifications only fire while the app is open or was used recently (iOS suspends web apps in the background). True push while closed would need a small push server.
- **Recurring**: tap any block side, then "Recurring reminders" to add a repeating calendar event (useful for your home block).

## Caveats
- GPS can be off by a few meters, so confirm the side of the street in the confirm screen.
- Holidays follow SFMTA's rules: daytime sweeping is off on all 12 City holidays. Nightly sweeping (12–6am) and meters stay on except New Year's, Thanksgiving and Christmas. Recurring calendar events skip holidays with EXDATEs.
- "I've left" stops the app's own reminders. Events you exported to your Calendar have to be deleted there, and the app lists them for you.
- Always check posted signs. Temporary signs for construction, events, or film shoots are not in this data.
