# TV dashboard

Full-screen dashboard for a living-room TV: crypto (TradingView widgets), Google Calendar, Chelsea's next fixture and a clock.

- `index.html` is the whole frontend (GitHub Pages, no build step). It reads its backend URL from `?api=<Apps Script web app URL>`.
- `apps-script/` is the Google Apps Script backend (deployed with clasp) returning calendar events and the next fixture (ESPN public API, TheSportsDB fallback).

The Apps Script URL is intentionally not stored in this repo.

## Screen share to the TV (LAN, WebRTC)

1. On the Mac: `cd screenshare && npm install && npm start`. It prints the sender URL and the
   `&share=<mac-ip>:8090&key=<key>` suffix for the TV's start URL. The key lives in `screenshare/.token`
   (git-ignored; delete it to rotate, then update the TV URL).
2. Open http://localhost:8090 in Chrome on the Mac, pick a preset and click **Start sharing**.
   The TV switches to the stream when the first frame decodes and back to the dashboard when you stop.

Fully Kiosk needs **Advanced Web Settings → Mixed Content Mode = Always allow** (the dashboard is
https, the Mac server is plain ws:// on the LAN) and **Autoplay Videos** on.

Latency notes: H.264 is hardware-encoded on the Mac and hardware-decoded on the TV. The TV's decoder
adds ~55–100 ms and sometimes stays busy after a previous session; the receiver detects "frames arrive
but none decode", asks for a fresh connection, and the sender falls back to VP8 after two failures.
720p decodes noticeably faster than 1080p on this TV. Wired Ethernet on the TV or 5 GHz Wi-Fi helps most.
Append `&sharebuffer=<ms>` to the TV URL to trade a little latency for smoothness on bad Wi-Fi.
