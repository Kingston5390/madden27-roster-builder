// Real NFL results from ESPN, for starting a franchise at a real week: every regular-season game that's final so far.
'use strict';
const { TEAM_ID } = require('./sync');

const API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
let cached = null;

// [{ week (1-18), home, away (franchise team index = roster team id - 1), homeScore, awayScore }], cached 10 minutes
async function fetchRealResults(year) {
  if (cached && cached.year === year && Date.now() - cached.at < 10 * 60e3) return cached.games;
  const games = [];
  for (let week = 1; week <= 18; week++) {
    const j = await (await fetch(`${API}/scoreboard?seasontype=2&week=${week}&dates=${year}`)).json();
    let finals = 0;
    for (const e of j.events ?? []) {
      if (!e.status?.type?.completed) continue;
      const c = e.competitions?.[0]?.competitors ?? [];
      const h = c.find(x => x.homeAway === 'home'), a = c.find(x => x.homeAway === 'away');
      const home = TEAM_ID[h?.team?.abbreviation], away = TEAM_ID[a?.team?.abbreviation];
      if (!home || !away) continue;
      games.push({ week, home: home - 1, away: away - 1, homeScore: Number(h.score), awayScore: Number(a.score), label: `${a.team.abbreviation} ${a.score} @ ${h.team.abbreviation} ${h.score}` });
      finals++;
    }
    if (!finals) break; // the first week with nothing final is the one being played now (or not started)
  }
  cached = { year, at: Date.now(), games };
  return games;
}

// conference and division by franchise team index (roster team id - 1)
const DIVISION = [['NFC', 'North'], ['AFC', 'North'], ['AFC', 'East'], ['AFC', 'West'], ['AFC', 'North'], ['NFC', 'South'], ['NFC', 'West'], ['AFC', 'West'],
  ['AFC', 'West'], ['AFC', 'South'], ['NFC', 'East'], ['AFC', 'East'], ['NFC', 'East'], ['NFC', 'South'], ['NFC', 'West'], ['NFC', 'East'], ['AFC', 'South'],
  ['AFC', 'East'], ['NFC', 'North'], ['NFC', 'North'], ['NFC', 'South'], ['AFC', 'East'], ['AFC', 'West'], ['NFC', 'West'], ['AFC', 'North'], ['NFC', 'East'],
  ['NFC', 'South'], ['NFC', 'West'], ['AFC', 'North'], ['AFC', 'South'], ['NFC', 'North'], ['AFC', 'South']];

module.exports = { fetchRealResults, DIVISION };
