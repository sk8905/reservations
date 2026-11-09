/**
 * Table Planner — Gmail forwarder (Google Apps Script).
 *
 * Every 5 minutes, sends NEW emails from booking platforms (OpenTable, Resy,
 * SevenRooms, Tock, DesignMyNight, Deliveroo) to your Table Planner, so a
 * "table now available" alert shows up on your dates and as a push.
 * It reads nothing else in your mailbox, and only sends to your own app.
 *
 * Setup: paste into script.google.com, run `setup` once and allow access.
 * To stop: run `stop` (or delete the project).
 */

const APP_URL = '__APP_URL__';      // your Table Planner address
const APP_TOKEN = '__APP_TOKEN__';  // your APP_TOKEN
const LABEL = 'table-planner-sent';
const QUERY = '(from:opentable OR from:resy.com OR from:sevenrooms.com OR from:exploretock.com OR from:tock.com '
  + 'OR from:designmynight.com OR from:deliveroo) newer_than:2d -label:' + LABEL;

function forwardTableAlerts() {
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(QUERY, 0, 25);
  for (const thread of threads) {
    for (const m of thread.getMessages()) {
      if (m.getDate().getTime() < Date.now() - 2 * 86400000) continue;
      const res = UrlFetchApp.fetch(APP_URL.replace(/\/$/, '') + '/api/inbox', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-app-token': APP_TOKEN },
        payload: JSON.stringify({
          id: m.getId(),
          from: m.getFrom(),
          subject: m.getSubject(),
          date: m.getDate().toISOString(),
          text: m.getPlainBody().slice(0, 30000),
          html: m.getBody().slice(0, 150000),
        }),
        muteHttpExceptions: true,
      });
      // On an error, leave the thread unlabelled so the next run retries it.
      if (res.getResponseCode() >= 300) throw new Error('Table Planner said ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    }
    thread.addLabel(label);
  }
}

function setup() {
  stop();
  ScriptApp.newTrigger('forwardTableAlerts').timeBased().everyMinutes(5).create();
  forwardTableAlerts();
}

function stop() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'forwardTableAlerts') ScriptApp.deleteTrigger(t);
  }
}
