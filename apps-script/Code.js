// TV dashboard backend: returns calendar events (today + 7 days) and Chelsea's next fixture as JSON.
// Fixtures: ESPN public API (site.web host; site.api.espn.com blocks Google's servers), TheSportsDB as fallback.
// Optional Script Property CALENDAR_IDS: comma-separated calendar IDs (default: all calendars in the account).

var TZ = 'Europe/Amsterdam';
var CHELSEA_ESPN_ID = '363';
var ESPN_URL_ = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/all/teams/' + CHELSEA_ESPN_ID + '/schedule?fixture=true';
var FETCH_HEADERS_ = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 'Accept': 'application/json' };

function doGet() {
  var out = { generated: new Date().toISOString(), timeZone: TZ };
  try { out.events = getEvents_(); } catch (e) { out.eventsError = String(e); }
  try { out.fixture = getNextFixture_(); } catch (e) { out.fixtureError = String(e); }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function getEvents_() {
  var props = PropertiesService.getScriptProperties();
  var prop = props.getProperty('CALENDAR_IDS');
  var cals = prop ? prop.split(',').map(function (id) {
    id = id.trim();
    return id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
  }) : CalendarApp.getAllCalendars();
  var start = new Date();
  start.setHours(0, 0, 0, 0);
  var end = new Date(start.getTime() + 8 * 24 * 3600 * 1000);
  var events = [], seen = {};
  cals.forEach(function (cal) {
    if (!cal) return;
    cal.getEvents(start, end).forEach(function (ev) {
      var key = ev.getTitle() + '|' + ev.getStartTime().getTime(); // overlapping imported timetables
      if (seen[key]) return;
      seen[key] = true;
      events.push({
        title: ev.getTitle() || '(no title)',
        start: ev.getStartTime().toISOString(),
        end: ev.getEndTime().toISOString(),
        allDay: ev.isAllDayEvent()
      });
    });
  });
  events.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  return events;
}

function getNextFixture_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('fixture');
  if (hit) return JSON.parse(hit);
  var fixture;
  try { fixture = fromEspn_(); } catch (err) { fixture = fromSportsDb_(); }
  if (fixture) cache.put('fixture', JSON.stringify(fixture), 1800);
  return fixture;
}

function fromEspn_() {
  var data = JSON.parse(UrlFetchApp.fetch(ESPN_URL_, { muteHttpExceptions: true, headers: FETCH_HEADERS_ }).getContentText());
  var now = Date.now() - 2 * 3600 * 1000; // keep showing a match that is in progress
  var ev = (data.events || []).filter(function (e) {
    var done = e.competitions && e.competitions[0].status && e.competitions[0].status.type.completed;
    return new Date(e.date).getTime() > now && !done;
  }).sort(function (a, b) { return new Date(a.date) - new Date(b.date); })[0];
  if (!ev) return null;

  var comps = ev.competitions[0].competitors;
  var us = comps.filter(function (c) { return c.team.id === CHELSEA_ESPN_ID; })[0];
  var them = comps.filter(function (c) { return c.team.id !== CHELSEA_ESPN_ID; })[0];
  var fixture = {
    opponent: them.team.displayName,
    opponentLogo: (them.team.logos && them.team.logos[0] && them.team.logos[0].href) || null,
    competition: (ev.league && ev.league.name) || (ev.seasonType && ev.seasonType.name) || '',
    kickoff: new Date(ev.date).toISOString(),
    home: us.homeAway === 'home',
    venue: (ev.competitions[0].venue && ev.competitions[0].venue.fullName) || '',
    source: 'espn'
  };
  return fixture;
}

function fromSportsDb_() {
  var r = UrlFetchApp.fetch('https://www.thesportsdb.com/api/v1/json/123/eventsnext.php?id=133610', { muteHttpExceptions: true });
  var ev = (JSON.parse(r.getContentText()).events || [])[0];
  if (!ev) return null;
  var home = ev.idHomeTeam === '133610';
  return {
    opponent: home ? ev.strAwayTeam : ev.strHomeTeam,
    opponentLogo: (home ? ev.strAwayTeamBadge : ev.strHomeTeamBadge) || null,
    competition: ev.strLeague || '',
    kickoff: new Date(ev.strTimestamp + 'Z').toISOString(),
    home: home,
    venue: ev.strVenue || '',
    source: 'thesportsdb'
  };
}
