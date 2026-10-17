# TV dashboard

Full-screen dashboard for a living-room TV: crypto (TradingView widgets), Google Calendar, Chelsea's next fixture and a clock.

- `index.html` is the whole frontend (GitHub Pages, no build step). It reads its backend URL from `?api=<Apps Script web app URL>`.
- `apps-script/` is the Google Apps Script backend (deployed with clasp) returning calendar events and the next fixture (ESPN public API, TheSportsDB fallback).

The Apps Script URL is intentionally not stored in this repo.
